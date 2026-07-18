import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { recordOutboundEvent } from './outbound-events.js';

/** Casa a prova do webhook/core pelo id numérico devolvido pela API. */
export async function reconcileAgentOutboundDelivery(
  client: PoolClient,
  environment: Environment,
  coreMessageId: string,
  chatwootMessageId: number,
): Promise<boolean> {
  const outbound = await client.query<{ id: string; turn_id: string | null; attempts: number }>(
    `UPDATE ops.outbound_messages
        SET status='delivered', delivered_at=now(), delivery_suspect_at=NULL,
            locked_at=NULL, locked_by=NULL, updated_at=now()
      WHERE environment=$1 AND provider_message_id=$2
        AND status IN ('sending','sent_api_ack')
      RETURNING id,turn_id,attempts`,
    [environment, chatwootMessageId],
  );
  const row = outbound.rows[0];
  if (!row) return false;
  if (row.turn_id) {
    await client.query(
      `UPDATE agent.turns
          SET status='delivered', delivered_message_id=$3,
              chatwoot_message_id=$2, delivery_suspect_at=NULL, error_message=NULL
        WHERE environment=$1 AND id=$4`,
      [environment, chatwootMessageId, coreMessageId, row.turn_id],
    );
  }
  await recordOutboundEvent(client, { environment, outboundId: row.id,
    attempt: row.attempts,
    fromStatus: 'sent_api_ack', toStatus: 'delivered', reason: 'core_webhook_confirmed' });
  return true;
}

/** Fecha a corrida webhook-antes-do-UPDATE da API. */
export async function reconcileAckAlreadyInCore(
  client: PoolClient,
  environment: Environment,
  outboundId: string,
  chatwootMessageId: number,
): Promise<boolean> {
  const core = await client.query<{ id: string }>(
    `SELECT id FROM core.messages
      WHERE environment=$1 AND chatwoot_message_id=$2
      ORDER BY sent_at DESC LIMIT 1`,
    [environment, chatwootMessageId],
  );
  const coreId = core.rows[0]?.id;
  if (!coreId) return false;
  const outbound = await client.query<{ turn_id: string | null }>(
    `SELECT turn_id FROM ops.outbound_messages
      WHERE environment=$1 AND id=$2 AND provider_message_id=$3`,
    [environment, outboundId, chatwootMessageId],
  );
  if (!outbound.rows[0]) return false;
  return reconcileAgentOutboundDelivery(client, environment, coreId, chatwootMessageId);
}

export async function reconcilePendingAcksFromCore(
  client: PoolClient,
  environment: Environment,
): Promise<number> {
  const matches = await client.query<{ core_id: string; chatwoot_message_id: string | number }>(
    `SELECT DISTINCT ON (o.id) m.id AS core_id,m.chatwoot_message_id
       FROM ops.outbound_messages o
       JOIN core.messages m ON m.environment=o.environment
        AND m.chatwoot_message_id=o.provider_message_id
      WHERE o.environment=$1 AND o.status='sent_api_ack'
      ORDER BY o.id,m.sent_at DESC LIMIT 50`,
    [environment],
  );
  let reconciled = 0;
  for (const match of matches.rows) {
    if (await reconcileAgentOutboundDelivery(client, environment, match.core_id,
      Number(match.chatwoot_message_id))) reconciled++;
  }
  return reconciled;
}
