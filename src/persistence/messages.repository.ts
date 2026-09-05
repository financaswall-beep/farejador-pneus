import type { PoolClient } from 'pg';
import type { MappedMessage } from '../normalization/message.mapper.js';

export interface UpsertedMessage {
  messageId: string;
  conversationId: string;
}

export async function upsertMessage(
  client: PoolClient,
  message: MappedMessage,
): Promise<UpsertedMessage> {
  const result = await client.query<{ id: string; conversation_id: string }>(
    `WITH ensured_conversation AS (
      INSERT INTO core.conversations (
        environment,
        chatwoot_conversation_id,
        chatwoot_account_id,
        chatwoot_inbox_id,
        current_status,
        started_at,
        last_event_at
      ) VALUES ($1, $3, $16, $17, 'open', $14, NULL)
      ON CONFLICT (environment, chatwoot_conversation_id) DO UPDATE
      SET chatwoot_account_id = EXCLUDED.chatwoot_account_id
      WHERE core.conversations.chatwoot_account_id <= 0 AND EXCLUDED.chatwoot_account_id > 0
      RETURNING id
    ),
    conversation_ref AS (
      SELECT id FROM ensured_conversation
      UNION ALL
      SELECT id
      FROM core.conversations
      WHERE environment = $1
        AND chatwoot_conversation_id = $3
      LIMIT 1
    ),
    existing_message AS (
      SELECT id, conversation_id
      FROM core.messages
      WHERE environment = $1
        AND chatwoot_message_id = $2
      ORDER BY sent_at DESC
      LIMIT 1
    ),
    updated_existing AS (
      UPDATE core.messages
      SET conversation_id = (SELECT id FROM conversation_ref),
          chatwoot_conversation_id = $3,
          sender_type = $4,
          sender_id = $5,
          message_type = $6,
          content = $7,
          content_type = $8,
          content_attributes = $9,
          native_message_id = $18,
          is_private = $10,
          status = $11,
          external_source_ids = $12,
          echo_id = $13,
          last_event_at = $15
      WHERE environment = $1
        AND chatwoot_message_id = $2
        AND (
          last_event_at IS NULL
          OR $15 >= last_event_at
        )
      RETURNING id, conversation_id
    ),
    inserted AS (
      INSERT INTO core.messages (
        environment, chatwoot_message_id, conversation_id, chatwoot_conversation_id,
        sender_type, sender_id, message_type, content, content_type, content_attributes,
        native_message_id, is_private, status, external_source_ids, echo_id, sent_at, last_event_at
      )
      SELECT
        $1, $2,
        (SELECT id FROM conversation_ref),
        $3, $4, $5, $6, $7, $8, $9, $18, $10, $11, $12, $13, $14, $15
      WHERE NOT EXISTS (SELECT 1 FROM existing_message)
      ON CONFLICT (environment, chatwoot_message_id, sent_at) DO UPDATE
      SET sender_type = EXCLUDED.sender_type,
          sender_id = EXCLUDED.sender_id,
          message_type = EXCLUDED.message_type,
          content = EXCLUDED.content,
          content_type = EXCLUDED.content_type,
          content_attributes = EXCLUDED.content_attributes,
          native_message_id = EXCLUDED.native_message_id,
          is_private = EXCLUDED.is_private,
          status = EXCLUDED.status,
          external_source_ids = EXCLUDED.external_source_ids,
          echo_id = EXCLUDED.echo_id,
          last_event_at = EXCLUDED.last_event_at
      WHERE core.messages.last_event_at IS NULL
         OR EXCLUDED.last_event_at >= core.messages.last_event_at
      RETURNING id, conversation_id
    )
    SELECT id, conversation_id FROM updated_existing
    UNION ALL
    SELECT id, conversation_id FROM inserted
    UNION ALL
    SELECT id, conversation_id FROM existing_message
    LIMIT 1`,
    [
      message.environment,
      message.chatwootMessageId,
      message.chatwootConversationId,
      message.senderType,
      message.senderId,
      message.messageType,
      message.content,
      message.contentType,
      JSON.stringify(message.contentAttributes),
      message.isPrivate,
      message.status,
      message.externalSourceIds ? JSON.stringify(message.externalSourceIds) : null,
      message.echoId,
      message.sentAt,
      message.lastEventAt,
      message.chatwootAccountId,
      message.chatwootInboxId,
      message.nativeMessageId,
    ],
  );

  const returned = result.rows[0];
  if (returned?.id && returned.conversation_id) {
    return {
      messageId: returned.id,
      conversationId: returned.conversation_id,
    };
  }

  const existing = await client.query<{ id: string; conversation_id: string }>(
    `SELECT id, conversation_id
     FROM core.messages
     WHERE environment = $1
       AND chatwoot_message_id = $2
     ORDER BY sent_at DESC
     LIMIT 1`,
    [message.environment, message.chatwootMessageId],
  );

  const existingRow = existing.rows[0];
  if (!existingRow?.id || !existingRow.conversation_id) {
    throw new Error(`core.messages id not found for chatwoot_message_id=${message.chatwootMessageId}`);
  }

  return {
    messageId: existingRow.id,
    conversationId: existingRow.conversation_id,
  };
}
