import type { PoolClient } from 'pg';
import type { ChatMessage } from './types.js';

const HISTORY_LIMIT = 30;

/**
 * Marcador injetado quando o cliente compartilhou um pino de localização. O
 * anexo de localização chega SEM texto, então a query principal (que exige
 * content não-vazio) o descarta e o LLM nunca saberia que veio um pino. Com a
 * camada GEO ligada, este marcador aparece como turn do cliente pra o bot poder
 * prosseguir pela proximidade (a coordenada crua é resolvida server-side por
 * getLatestCustomerLocation — o LLM nunca vê lat/lng).
 */
export const LOCATION_MARKER = '[O cliente compartilhou a localização dele 📍]';

interface MessageRow {
  id: string;
  sender_type: string;
  content: string | null;
  sent_at: Date;
}

interface TurnActionsRow {
  trigger_message_id: string | null;
  actions: ChatMessage[] | null;
}

/**
 * Carrega histórico completo da conversa, incluindo tool_calls e tool_results
 * que o bot fez em turns anteriores. Sem isso, o LLM "esquece" o que descobriu
 * (product_ids, estoque, preços) entre turns.
 *
 * Estratégia: pega mensagens do core.messages + actions persistidas em
 * agent.turns.actions, e intercala na ordem certa.
 */
export async function loadHistory(
  client: PoolClient,
  conversationId: string,
  opts: { includeLocationMarkers?: boolean; includeAudio?: boolean; includeOrganic?: boolean } = {},
): Promise<ChatMessage[]> {
  const [msgResult, turnsResult] = await Promise.all([
    client.query<MessageRow>(
      // ORDER BY sent_at DESC, id DESC: o id como tiebreaker garante ordem
      // deterministica quando 2+ msgs do cliente vem com o mesmo timestamp
      // (acontece em rajada coalesced). Sem isso, o prefix do prompt pode
      // mudar entre turns e quebrar o prompt caching da OpenAI.
      `SELECT id, sender_type, content, sent_at
       FROM core.messages
       WHERE conversation_id = $1
         AND is_private = false
         AND deleted_at IS NULL
         AND content IS NOT NULL
         AND content <> ''
       ORDER BY sent_at DESC, id DESC
       LIMIT $2`,
      [conversationId, HISTORY_LIMIT],
    ),
    client.query<TurnActionsRow>(
      `SELECT trigger_message_id, actions
       FROM agent.turns
       WHERE conversation_id = $1
         AND agent_version = 'v2'
         AND actions IS NOT NULL
       ORDER BY created_at ASC`,
      [conversationId],
    ),
  ]);

  // Indexa actions por trigger_message_id (a mensagem do cliente que disparou aquela sequência de tools)
  const actionsByTrigger = new Map<string, ChatMessage[]>();
  for (const row of turnsResult.rows) {
    if (row.trigger_message_id && row.actions && Array.isArray(row.actions)) {
      actionsByTrigger.set(row.trigger_message_id, row.actions);
    }
  }

  // Monta histórico em ordem cronológica.
  // Para cada mensagem do cliente, se houver tool events disparados por ela,
  // injeta esses events ANTES da próxima mensagem do bot.
  const messages = msgResult.rows.reverse();

  // Camada GEO: traz os pinos de localização (que a query principal descarta por
  // não terem texto) e injeta um marcador na posição cronológica certa. Só roda
  // com a flag ligada → com a flag OFF o histórico é byte a byte o de hoje.
  if (opts.includeLocationMarkers) {
    const locResult = await client.query<{ id: string; sent_at: Date }>(
      `SELECT DISTINCT a.message_id AS id, m.sent_at
         FROM core.message_attachments a
         JOIN core.messages m ON m.id = a.message_id
        WHERE a.conversation_id = $1
          AND a.file_type = 'location'
          AND a.coordinates_lat IS NOT NULL
          AND m.is_private = false
          AND m.deleted_at IS NULL
        ORDER BY m.sent_at DESC, a.message_id DESC
        LIMIT $2`,
      [conversationId, HISTORY_LIMIT],
    );

    const seen = new Set(messages.map((m) => m.id));
    for (const loc of locResult.rows) {
      // Se o pino já veio com legenda (raro), ele já está no histórico — não duplica.
      if (!seen.has(loc.id)) {
        messages.push({ id: loc.id, sender_type: 'contact', content: LOCATION_MARKER, sent_at: loc.sent_at });
      }
    }
    // Reordena cronologicamente (asc), igual ao reverse do SELECT principal.
    messages.sort((a, b) => {
      const t = a.sent_at.getTime() - b.sent_at.getTime();
      if (t !== 0) return t;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  const history: ChatMessage[] = [];
  if(opts.includeOrganic) {
    const privateReplies=await client.query<MessageRow>(`SELECT o.id,'user' sender_type,o.body content,COALESCE(o.submitted_at,o.sent_at) sent_at
      FROM analytics.organic_conversation_sources s JOIN ops.organic_outreach o
        ON o.environment=s.environment AND o.id=s.outreach_id
      WHERE s.conversation_id=$1 AND s.superseded_by IS NULL
        AND NOT EXISTS(SELECT 1 FROM core.messages m WHERE m.environment=s.environment
          AND m.conversation_id=s.conversation_id AND m.native_message_id=o.provider_message_id)
      ORDER BY o.sent_at DESC LIMIT 3`,[conversationId]);
    messages.push(...privateReplies.rows);
    messages.sort((a,b)=>a.sent_at.getTime()-b.sent_at.getTime() || a.id.localeCompare(b.id));
  }
  if(opts.includeAudio) {
    const audio=await client.query<{id:string;sent_at:Date;content:string}>(`SELECT m.id,m.sent_at,
      string_agg(CASE WHEN t.transcript IS NOT NULL THEN
        CASE WHEN t.model='gpt-transcribe' THEN '[Áudio transcrito; certeza não informada pelo transcritor. Confirme dados antes de mudar pedido.] '
          ELSE '[Áudio transcrito; confiança '||t.confidence_level||'] ' END||t.transcript
        ELSE '[O cliente enviou áudio, mas não foi possível transcrever. Peça texto ou ofereça um atendente.]' END,E'\n' ORDER BY a.chatwoot_attachment_id) content
      FROM core.messages m JOIN core.message_attachments a ON a.environment=m.environment AND a.message_id=m.id AND a.file_type='audio'
      LEFT JOIN analytics.audio_transcriptions t ON t.environment=a.environment AND t.attachment_id=a.id AND t.superseded_by IS NULL
      WHERE m.conversation_id=$1 AND m.sender_type='contact' AND NOT m.is_private AND m.deleted_at IS NULL
      GROUP BY m.id,m.sent_at ORDER BY m.sent_at DESC LIMIT 30`,[conversationId]);
    for(const row of audio.rows){const found=messages.find(m=>m.id===row.id);
      if(found)found.content=[found.content,row.content].filter(Boolean).join('\n');
      else messages.push({...row,sender_type:'contact'});}
    messages.sort((a,b)=>a.sent_at.getTime()-b.sent_at.getTime() || a.id.localeCompare(b.id));
    if(messages.length>HISTORY_LIMIT)messages.splice(0,messages.length-HISTORY_LIMIT);
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const role = msg.sender_type === 'contact' ? ('user' as const) : ('assistant' as const);
    history.push({ role, content: msg.content ?? '' });

    // Se foi mensagem do cliente, e existem actions disparadas por ela,
    // injeta antes da próxima mensagem (que deve ser a resposta do bot).
    if (role === 'user') {
      const actions = actionsByTrigger.get(msg.id);
      if (actions && actions.length > 0) {
        history.push(...actions);
      }
    }
  }

  return history;
}

export async function lookupChatwootConversationId(
  client: PoolClient,
  conversationId: string,
): Promise<number | null> {
  const result = await client.query<{ chatwoot_conversation_id: number }>(
    `SELECT chatwoot_conversation_id
     FROM core.conversations
     WHERE id = $1
     LIMIT 1`,
    [conversationId],
  );
  return result.rows[0]?.chatwoot_conversation_id ?? null;
}

export async function lookupContactId(
  client: PoolClient,
  conversationId: string,
): Promise<string | null> {
  const result = await client.query<{ contact_id: string }>(
    `SELECT co.id AS contact_id
     FROM core.conversations cv
     JOIN core.contacts co
       ON co.environment = cv.environment
      AND co.chatwoot_contact_id = (cv.payload->>'contact_id')::bigint
     WHERE cv.id = $1
     LIMIT 1`,
    [conversationId],
  );
  return result.rows[0]?.contact_id ?? null;
}
