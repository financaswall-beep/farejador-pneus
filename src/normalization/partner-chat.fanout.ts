/**
 * Fan-out do chat unificado do Portal Parceiro (Fatia 1).
 *
 * Espelha mensagens do Chatwoot em commerce.partner_conversations /
 * commerce.partner_messages durante a normalizacao, pra o parceiro ver a
 * conversa dentro do portal (aba Bate-papo) sem abrir o Chatwoot.
 *
 * Princípios:
 *  - Roda DENTRO da transacao da normalizacao (pool do bot, BYPASSRLS) — grava
 *    o unit_id certo direto.
 *  - DEFENSIVO: usa SAVEPOINT proprio e NUNCA lanca erro pro chamador. Um bug
 *    aqui jamais pode quebrar a ingestao core (raw -> core), que e o caminho
 *    critico de producao.
 *  - Idempotente: dedup do eco via UNIQUE(environment, chatwoot_message_id);
 *    unread/last_message_at so sobem quando a mensagem e realmente nova.
 *
 * Atribuicao (Fatia 1): a conversa vai pra UNICA unidade de parceiro ativa do
 * ambiente. Quando a rede tiver varios parceiros, o roteamento (bot-triagem)
 * passa a definir a unidade — este modulo entao deixa de adivinhar.
 *
 * Plano: docs/PLANO_CHAT_UNIFICADO_PARCEIRO_2026-05-29.md (passo 1.2).
 */
import type { PoolClient } from 'pg';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import type { MappedMessage } from './message.mapper.js';

function readObject(source: unknown, key: string): Record<string, unknown> | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readString(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Mapeia o canal do Chatwoot pro nosso enum textual.
 *
 * Inboxes NATIVOS trazem `conversation.channel = "Channel::Whatsapp"` etc.
 * Mas Instagram/Facebook costumam entrar por um inbox do tipo API
 * (`Channel::Api`), em que o Chatwoot NÃO rotula a origem — só o NOME do inbox
 * (`payload.inbox.name`, ex. "Facebook", "Instagram") revela o canal real.
 * Por isso juntamos todas as pistas num "palheiro" e procuramos a palavra-chave.
 */
function deriveChannel(rawPayload: Record<string, unknown>): 'whatsapp' | 'instagram' | 'facebook' | 'other' {
  const conversation = readObject(rawPayload, 'conversation');
  const additional = readObject(conversation, 'additional_attributes');
  const inbox = readObject(rawPayload, 'inbox');
  const haystack = [
    readString(conversation, 'channel'),
    readString(additional, 'channel_type'),
    readString(inbox, 'channel_type'),
    readString(inbox, 'name'),
    readString(rawPayload, 'channel'),
  ]
    .filter((s): s is string => !!s)
    .join(' ')
    .toLowerCase();

  if (haystack.includes('whatsapp')) return 'whatsapp';
  if (haystack.includes('instagram')) return 'instagram';
  if (haystack.includes('facebook')) return 'facebook';
  return 'other';
}

/** Extrai nome/identificador do cliente do payload da mensagem (meta.sender é sempre o contato). */
function deriveCustomer(rawPayload: Record<string, unknown>): { name: string | null; identifier: string | null } {
  const conversation = readObject(rawPayload, 'conversation');
  const meta = readObject(conversation, 'meta');
  const metaSender = readObject(meta, 'sender');
  const topSender = readObject(rawPayload, 'sender');
  const sender = metaSender ?? topSender;
  return {
    name: readString(sender, 'name'),
    identifier: readString(sender, 'phone_number') ?? readString(sender, 'identifier'),
  };
}

interface ChatProjection {
  direction: 'inbound' | 'outbound';
  sender: 'customer' | 'bot' | 'partner';
  unreadDelta: number;
}

/**
 * Decide se a mensagem entra no chat do parceiro e como.
 * Retorna null quando deve ser ignorada (nota interna, atividade, sem texto, sistema).
 */
function projectMessage(message: MappedMessage): ChatProjection | null {
  // Notas internas do Chatwoot nunca aparecem pro cliente nem pro parceiro.
  if (message.isPrivate) return null;
  // messageType: 0=incoming, 1=outgoing, 2=activity, 3=template. Atividade é ruído.
  if (message.messageType === 2) return null;
  // Fatia 1 é só texto; anexos entram na Fatia 4.
  if (!message.content || message.content.trim().length === 0) return null;

  if (message.messageType === 0) {
    // Entrada do cliente.
    if (message.senderType !== 'contact') return null;
    return { direction: 'inbound', sender: 'customer', unreadDelta: 1 };
  }

  // Saída (outgoing): bot ou humano/parceiro.
  if (message.senderType === 'system') return null;
  const sender = message.senderType === 'agent_bot' ? 'bot' : 'partner';
  return { direction: 'outbound', sender, unreadDelta: 0 };
}

/**
 * Resolve a unidade de parceiro alvo (Fatia 1: a única ativa do ambiente).
 * Retorna unit_id (core.units.id) ou null se não houver exatamente uma.
 */
async function resolveDefaultPartnerUnit(client: PoolClient, environment: string): Promise<string | null> {
  const result = await client.query<{ unit_id: string }>(
    `SELECT unit_id
       FROM network.partner_units
      WHERE environment = $1 AND status = 'active' AND deleted_at IS NULL`,
    [environment],
  );
  if (result.rowCount !== 1) {
    return null;
  }
  return result.rows[0]!.unit_id;
}

/**
 * Espelha uma mensagem do Chatwoot no chat do parceiro. Nunca lança.
 * Deve ser chamada DENTRO da transação de normalização, em message_created.
 */
export async function fanOutMessageToPartnerChat(
  client: PoolClient,
  message: MappedMessage,
  rawPayload: Record<string, unknown>,
): Promise<void> {
  if (!env.PARTNER_CHAT_FANOUT_ENABLED) return;

  const projection = projectMessage(message);
  if (!projection) return;

  // SAVEPOINT: qualquer falha aqui é desfeita sem abortar a normalização core.
  await client.query('SAVEPOINT partner_chat_fanout');
  try {
    const unitId = await resolveDefaultPartnerUnit(client, message.environment);
    if (!unitId) {
      logger.debug(
        { environment: message.environment, chatwoot_conversation_id: message.chatwootConversationId },
        'partner chat fanout: nenhuma unidade de parceiro única ativa — pulando',
      );
      await client.query('RELEASE SAVEPOINT partner_chat_fanout');
      return;
    }

    const channel = deriveChannel(rawPayload);
    const customer = deriveCustomer(rawPayload);

    // 1) Garante a conversa (upsert idempotente). Atualiza metadados se vierem
    //    e ainda estiverem vazios; nunca regride canal já identificado.
    const convResult = await client.query<{ id: string }>(
      `INSERT INTO commerce.partner_conversations
         (environment, unit_id, chatwoot_conversation_id, channel, customer_name, customer_identifier, last_message_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (environment, chatwoot_conversation_id) DO UPDATE SET
         customer_name       = COALESCE(commerce.partner_conversations.customer_name, EXCLUDED.customer_name),
         customer_identifier = COALESCE(commerce.partner_conversations.customer_identifier, EXCLUDED.customer_identifier),
         channel             = CASE WHEN commerce.partner_conversations.channel = 'other'
                                    THEN EXCLUDED.channel ELSE commerce.partner_conversations.channel END
       RETURNING id`,
      [
        message.environment,
        unitId,
        message.chatwootConversationId,
        channel,
        customer.name,
        customer.identifier,
        message.sentAt,
      ],
    );
    const conversationId = convResult.rows[0]!.id;

    // 2) Eco da nossa própria mensagem (Fatia 2): casa a linha OTIMISTA que o
    //    portal já inseriu e adota o chatwoot_message_id, em vez de duplicar.
    //    a) por echo_id (quando o Chatwoot ecoa o client_token);
    //    b) FALLBACK por conteúdo: este Chatwoot/integração NÃO ecoa echo_id
    //       (verificado em prod: payload.echo_id vem sempre null nos outgoing),
    //       então casamos a linha otimista mais recente da MESMA conversa,
    //       outbound, ainda sem chatwoot_message_id, com o MESMO conteúdo, numa
    //       janela de 10min. Idempotente: o UNIQUE(environment, chatwoot_message_id)
    //       é a rede de segurança final contra reentrega do webhook.
    let recordedNew = false;
    if (projection.direction === 'outbound') {
      if (message.echoId) {
        const claimByEcho = await client.query(
          `UPDATE commerce.partner_messages
              SET chatwoot_message_id = $1
            WHERE environment = $2 AND client_token = $3 AND chatwoot_message_id IS NULL`,
          [message.chatwootMessageId, message.environment, message.echoId],
        );
        if ((claimByEcho.rowCount ?? 0) > 0) {
          await client.query('RELEASE SAVEPOINT partner_chat_fanout');
          return; // era a nossa própria mensagem; já estava na tela.
        }
      }

      const claimByContent = await client.query(
        `UPDATE commerce.partner_messages
            SET chatwoot_message_id = $1
          WHERE id = (
            SELECT id FROM commerce.partner_messages
             WHERE environment = $2 AND conversation_id = $3
               AND direction = 'outbound' AND chatwoot_message_id IS NULL
               AND content IS NOT DISTINCT FROM $4
               AND created_at > now() - interval '10 minutes'
             ORDER BY created_at DESC
             LIMIT 1
          )`,
        [message.chatwootMessageId, message.environment, conversationId, message.content],
      );
      if ((claimByContent.rowCount ?? 0) > 0) {
        await client.query('RELEASE SAVEPOINT partner_chat_fanout');
        return; // casou a otimista pelo conteúdo; não duplica.
      }
    }

    // 3) Insere a mensagem. Dedup do eco via UNIQUE(environment, chatwoot_message_id).
    //    O índice é PARCIAL (partner_messages_cw_uniq ... WHERE chatwoot_message_id
    //    IS NOT NULL, p/ permitir várias mensagens otimistas com id nulo). Postgres
    //    exige repetir esse predicado no ON CONFLICT pra inferir o índice; sem ele
    //    estoura 42P10 ("no unique or exclusion constraint matching").
    const msgResult = await client.query(
      `INSERT INTO commerce.partner_messages
         (environment, unit_id, conversation_id, chatwoot_message_id, direction, sender, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (environment, chatwoot_message_id) WHERE chatwoot_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        message.environment,
        unitId,
        conversationId,
        message.chatwootMessageId,
        projection.direction,
        projection.sender,
        message.content,
        // Horário REAL da mensagem (Chatwoot), não o do insert — senão a
        // reconciliação grava tudo com a hora do backfill e bagunça a ordem.
        message.sentAt,
      ],
    );
    recordedNew = (msgResult.rowCount ?? 0) > 0;

    // 4) Só mexe em last_message_at / unread quando a mensagem é realmente nova
    //    (evita contar duas vezes em retry/eco do webhook).
    if (recordedNew) {
      await client.query(
        `UPDATE commerce.partner_conversations
            SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
                unread_count    = unread_count + $3
          WHERE id = $1`,
        [conversationId, message.sentAt, projection.unreadDelta],
      );
    }

    await client.query('RELEASE SAVEPOINT partner_chat_fanout');
  } catch (err) {
    // Defesa: desfaz só o fan-out, deixa a normalização core seguir.
    await client.query('ROLLBACK TO SAVEPOINT partner_chat_fanout').catch(() => undefined);
    logger.error(
      {
        err,
        environment: message.environment,
        chatwoot_conversation_id: message.chatwootConversationId,
        chatwoot_message_id: message.chatwootMessageId,
      },
      'partner chat fanout failed (normalização core não afetada)',
    );
  }
}
