import type { PoolClient } from 'pg';
import type { OutboundRow } from './outbound-worker.js';
import { recordOutboundEvent } from './outbound-events.js';
import { reconcileAckAlreadyInCore } from './outbound-reconcile.js';

export async function markOutboundAck(client: PoolClient, row: OutboundRow, providerId: number | null): Promise<void> {
  await client.query(
    `UPDATE ops.outbound_messages SET status='sent_api_ack',provider_message_id=$2,
       sent_at=now(),locked_at=NULL,locked_by=NULL,last_error_code=NULL,
       last_error_kind=NULL,last_error_summary=NULL,updated_at=now() WHERE id=$1`,
    [row.id, providerId],
  );
  if (row.turn_id) await client.query(
    `UPDATE agent.turns SET status='sent_api_ack',chatwoot_message_id=$2,
       sent_at=now(),error_message=NULL WHERE id=$1`, [row.turn_id, providerId]);
  await recordOutboundEvent(client, { environment: row.environment, outboundId: row.id,
    attempt: row.attempts, fromStatus: 'sending', toStatus: 'sent_api_ack',
    reason: providerId == null ? 'provider_accepted_without_id' : 'provider_accepted' });
  if (providerId != null) {
    await reconcileAckAlreadyInCore(client, row.environment, row.id, providerId);
  }
}

export async function markResolutionDelivered(client: PoolClient, row: OutboundRow): Promise<void> {
  await client.query(
    `UPDATE ops.outbound_messages SET status='delivered',sent_at=now(),delivered_at=now(),
       locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_kind=NULL,
       last_error_summary=NULL,updated_at=now() WHERE id=$1 AND status='sending'`,
    [row.id],
  );
  await recordOutboundEvent(client, { environment: row.environment, outboundId: row.id,
    attempt: row.attempts, fromStatus: 'sending', toStatus: 'delivered',
    reason: 'conversation_resolved' });
}
