import type { PoolClient } from 'pg';
import type { MappedConversation } from '../normalization/conversation.mapper.js';

export async function upsertConversation(
  client: PoolClient,
  conversation: MappedConversation,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO core.conversations (
      environment, chatwoot_conversation_id, chatwoot_account_id, chatwoot_inbox_id,
      channel_type, contact_id, current_status, current_assignee_id, current_team_id,
      priority, started_at, first_reply_at, last_activity_at, resolved_at, waiting_since,
      message_count_cache, additional_attributes, custom_attributes, last_event_at
    ) VALUES (
      $1::text, $2::bigint, $3::bigint, $4::bigint, $5::text,
      (SELECT id FROM core.contacts WHERE environment = $1::text AND chatwoot_contact_id = $6::bigint),
      $7::text, $8::bigint, $9::bigint, $10::text, $11::timestamptz, $12::timestamptz,
      $13::timestamptz, $14::timestamptz, $15::timestamptz, $16::integer,
      $17::jsonb, $18::jsonb, $19::timestamptz
    )
    ON CONFLICT (environment, chatwoot_conversation_id) DO UPDATE
    SET chatwoot_account_id = CASE WHEN EXCLUDED.chatwoot_account_id > 0
          THEN EXCLUDED.chatwoot_account_id ELSE core.conversations.chatwoot_account_id END,
        chatwoot_inbox_id = EXCLUDED.chatwoot_inbox_id,
        channel_type = EXCLUDED.channel_type,
        contact_id = EXCLUDED.contact_id,
        current_status = EXCLUDED.current_status,
        current_assignee_id = EXCLUDED.current_assignee_id,
        current_team_id = EXCLUDED.current_team_id,
        priority = EXCLUDED.priority,
        started_at = EXCLUDED.started_at,
        first_reply_at = EXCLUDED.first_reply_at,
        last_activity_at = EXCLUDED.last_activity_at,
        resolved_at = EXCLUDED.resolved_at,
        waiting_since = EXCLUDED.waiting_since,
        message_count_cache = EXCLUDED.message_count_cache,
        additional_attributes = EXCLUDED.additional_attributes,
        custom_attributes = EXCLUDED.custom_attributes,
        last_event_at = EXCLUDED.last_event_at,
        updated_at = now()
    WHERE core.conversations.last_event_at IS NULL
       OR EXCLUDED.last_event_at >= core.conversations.last_event_at
    RETURNING id`,
    [
      conversation.environment,
      conversation.chatwootConversationId,
      conversation.chatwootAccountId,
      conversation.chatwootInboxId,
      conversation.channelType,
      conversation.chatwootContactId,
      conversation.currentStatus,
      conversation.currentAssigneeId,
      conversation.currentTeamId,
      conversation.priority,
      conversation.startedAt,
      null,
      conversation.lastActivityAt,
      conversation.resolvedAt,
      conversation.waitingSince,
      0,
      JSON.stringify(conversation.additionalAttributes),
      JSON.stringify(conversation.customAttributes),
      conversation.lastEventAt,
    ],
  );

  const returnedId = result.rows[0]?.id;
  if (returnedId) {
    return returnedId;
  }

  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM core.conversations
     WHERE environment = $1::text
       AND chatwoot_conversation_id = $2::bigint`,
    [conversation.environment, conversation.chatwootConversationId],
  );

  const existingId = existing.rows[0]?.id;
  if (!existingId) {
    throw new Error(`core.conversations id not found for chatwoot_conversation_id=${conversation.chatwootConversationId}`);
  }

  return existingId;
}
