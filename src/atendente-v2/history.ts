import type { PoolClient } from 'pg';
import type { ChatMessage } from './types.js';

const HISTORY_LIMIT = 30;

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
): Promise<ChatMessage[]> {
  const [msgResult, turnsResult] = await Promise.all([
    client.query<MessageRow>(
      `SELECT id, sender_type, content, sent_at
       FROM core.messages
       WHERE conversation_id = $1
         AND is_private = false
         AND deleted_at IS NULL
         AND content IS NOT NULL
         AND content <> ''
       ORDER BY sent_at DESC
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
  const history: ChatMessage[] = [];

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
