import type { PoolClient } from 'pg';
import type { ChatMessage } from './types.js';

const HISTORY_LIMIT = 30;

interface MessageRow {
  sender_type: string;
  content: string | null;
  is_private: boolean;
  sent_at: Date;
}

export async function loadHistory(
  client: PoolClient,
  conversationId: string,
): Promise<ChatMessage[]> {
  const result = await client.query<MessageRow>(
    `SELECT sender_type, content, is_private, sent_at
     FROM core.messages
     WHERE conversation_id = $1
       AND is_private = false
       AND deleted_at IS NULL
       AND content IS NOT NULL
       AND content <> ''
     ORDER BY sent_at DESC
     LIMIT $2`,
    [conversationId, HISTORY_LIMIT],
  );

  return result.rows
    .reverse()
    .map((row) => ({
      role: row.sender_type === 'contact' ? ('user' as const) : ('assistant' as const),
      content: row.content ?? '',
    }));
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
