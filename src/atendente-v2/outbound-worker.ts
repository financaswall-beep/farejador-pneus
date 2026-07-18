import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ChatwootApiError } from '../admin/chatwoot-api.client.js';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { classifyAtendenteError, MAX_ATENDENTE_RETRY_ATTEMPTS,
  retryBackoffSeconds } from '../shared/repositories/ops-atendente-retry.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { reconcileAckAlreadyInCore, reconcilePendingAcksFromCore } from './outbound-reconcile.js';
import { recordOutboundEvent } from './outbound-events.js';
import { deliverOutboundRow, markPhotoRequestSent } from './outbound-delivery.js';

const WORKER_ID = `bot-outbox-${randomUUID().slice(0, 8)}`;
const POLL_MS = 2_000;
const UNKNOWN_SENDING_MINUTES = 10;
const DELIVERY_SUSPECT_MINUTES = 10;

export interface OutboundRow {
  id: string;
  environment: Environment;
  conversation_id: string;
  turn_id: string | null;
  chatwoot_conversation_id: string | number;
  echo_id: string | null;
  kind: string;
  body: string;
  attempts: number;
}

async function openOutboundDeadLetter(
  client: PoolClient, row: Pick<OutboundRow, 'id' | 'environment' | 'conversation_id'>,
  reason: string, code: string, kind: string, summary: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ops.atendente_dead_letters (
       environment,outbound_id,conversation_id,actor,reason,error_code,error_kind,error_summary
     ) VALUES ($1,$2,$3,'system',$4,$5,$6,$7)
     ON CONFLICT (environment,outbound_id) WHERE outbound_id IS NOT NULL AND resolved_at IS NULL
     DO UPDATE SET reason=EXCLUDED.reason,error_code=EXCLUDED.error_code,
                   error_kind=EXCLUDED.error_kind,error_summary=EXCLUDED.error_summary`,
    [row.environment, row.id, row.conversation_id, reason, code, kind, summary],
  );
}

export async function reclaimAmbiguousOutbound(
  client: PoolClient, environment: Environment,
): Promise<number> {
  const stuck = await client.query<OutboundRow>(
    `UPDATE ops.outbound_messages
        SET status='dead_letter', locked_at=NULL, locked_by=NULL,
            last_error_code='delivery_unknown', last_error_kind='ambiguous',
            last_error_summary='process_stopped_while_provider_result_unknown', updated_at=now()
      WHERE environment=$1 AND status='sending'
        AND locked_at < now() - ($2 || ' minutes')::interval
      RETURNING id,environment,conversation_id,turn_id,chatwoot_conversation_id,
                echo_id,kind,body,attempts`,
    [environment, String(UNKNOWN_SENDING_MINUTES)],
  );
  for (const row of stuck.rows) {
    await openOutboundDeadLetter(client, row, 'delivery_unknown_after_worker_crash',
      'delivery_unknown', 'ambiguous', 'provider_may_have_received_message');
    await recordOutboundEvent(client, { environment, outboundId: row.id,
      attempt: row.attempts, fromStatus: 'sending', toStatus: 'dead_letter',
      reason: 'worker_crash_delivery_unknown', errorCode: 'delivery_unknown',
      errorKind: 'ambiguous', errorSummary: 'provider_may_have_received_message' });
    if (row.turn_id) await client.query(
      `UPDATE agent.turns SET status='blocked',error_message='delivery_unknown'
        WHERE environment=$1 AND id=$2`, [environment, row.turn_id]);
  }
  return stuck.rowCount ?? 0;
}

export async function markDeliverySuspects(
  client: PoolClient, environment: Environment,
): Promise<number> {
  const result = await client.query<{ id: string; turn_id: string | null; attempts: number }>(
    `UPDATE ops.outbound_messages
        SET delivery_suspect_at=COALESCE(delivery_suspect_at,now()),updated_at=now()
      WHERE environment=$1 AND status='sent_api_ack' AND delivery_suspect_at IS NULL
        AND sent_at < now() - ($2 || ' minutes')::interval
      RETURNING id,turn_id,attempts`,
    [environment, String(DELIVERY_SUSPECT_MINUTES)],
  );
  for (const row of result.rows) {
    if (row.turn_id) await client.query(
      `UPDATE agent.turns SET delivery_suspect_at=COALESCE(delivery_suspect_at,now())
        WHERE environment=$1 AND id=$2`, [environment, row.turn_id]);
    await recordOutboundEvent(client, { environment, outboundId: row.id,
      attempt: row.attempts, fromStatus: 'sent_api_ack', toStatus: 'sent_api_ack',
      reason: 'webhook_confirmation_timeout' });
  }
  return result.rowCount ?? 0;
}

/** Descarta rascunhos de resposta que perderam o contexto enquanto aguardavam retry. */
export async function supersedeStaleAgentOutbound(
  client: PoolClient,
  environment: Environment,
): Promise<number> {
  const stale = await client.query<{ id: string; turn_id: string | null }>(
    `WITH candidates AS (
       SELECT o2.id,
         (SELECT m.id FROM core.messages trigger_msg
          JOIN core.messages m ON m.environment=trigger_msg.environment
           AND m.conversation_id=trigger_msg.conversation_id
           AND m.sender_type='contact' AND m.is_private=false
           AND m.sent_at>trigger_msg.sent_at
          WHERE trigger_msg.environment=o2.environment
            AND trigger_msg.id=o2.trigger_message_id
          ORDER BY m.sent_at DESC LIMIT 1) AS newer_id
       FROM ops.outbound_messages o2
       WHERE o2.environment=$1 AND o2.kind='agent_text'
         AND o2.status IN ('pending','failed')
     )
     UPDATE ops.outbound_messages o
        SET status='superseded',superseded_by_message_id=newer.newer_id,
            last_error_kind='superseded',last_error_summary='newer_customer_message',
            locked_at=NULL,locked_by=NULL,updated_at=now()
       FROM candidates newer
      WHERE o.id=newer.id AND newer.newer_id IS NOT NULL
      RETURNING o.id,o.turn_id`,
    [environment],
  );
  for (const row of stale.rows) {
    if (row.turn_id) await client.query(
      `UPDATE agent.turns SET status='blocked',error_message='superseded:newer_customer_message'
        WHERE environment=$1 AND id=$2 AND status IN ('generated','failed')`,
      [environment, row.turn_id],
    );
    await recordOutboundEvent(client, { environment, outboundId: row.id,
      fromStatus: 'pending_or_failed', toStatus: 'superseded',
      reason: 'newer_customer_message' });
  }
  return stale.rowCount ?? 0;
}

export async function pickOutboundMessage(
  client: PoolClient, environment: Environment, workerId = WORKER_ID,
): Promise<OutboundRow | null> {
  const picked = await client.query<OutboundRow>(
    `WITH candidate AS (
       SELECT id FROM ops.outbound_messages
        WHERE environment=$1 AND status IN ('pending','failed') AND not_before<=now()
        ORDER BY not_before,created_at LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE ops.outbound_messages o
        SET status='sending',attempts=attempts+1,locked_at=now(),locked_by=$2,updated_at=now()
       FROM candidate c WHERE o.id=c.id
     RETURNING o.id,o.environment,o.conversation_id,o.turn_id,o.chatwoot_conversation_id,
               o.echo_id,o.kind,o.body,o.attempts`,
    [environment, workerId],
  );
  const row = picked.rows[0] ?? null;
  if (row) await recordOutboundEvent(client, { environment, outboundId: row.id,
    actor: workerId, attempt: row.attempts, fromStatus: 'pending_or_failed',
    toStatus: 'sending', reason: 'picked' });
  return row;
}

async function markOutboundAck(client: PoolClient, row: OutboundRow, providerId: number | null): Promise<void> {
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

export async function markOutboundFailure(
  client: PoolClient,
  row: OutboundRow,
  error: unknown,
): Promise<void> {
  const failure = classifyAtendenteError(error);
  const ambiguous = error instanceof ChatwootApiError && error.status === null;
  const retry = !ambiguous && failure.retryable && row.attempts < MAX_ATENDENTE_RETRY_ATTEMPTS;
  if (retry) {
    await client.query(
      `UPDATE ops.outbound_messages SET status='failed',not_before=now()+($2||' seconds')::interval,
       locked_at=NULL,locked_by=NULL,last_error_code=$3,last_error_kind=$4,
       last_error_summary=$5,updated_at=now() WHERE id=$1`,
      [row.id, String(retryBackoffSeconds(row.attempts + 1)), failure.code,
        failure.kind, failure.summary],
    );
    await recordOutboundEvent(client, { environment: row.environment, outboundId: row.id,
      attempt: row.attempts, fromStatus: 'sending', toStatus: 'failed',
      reason: 'automatic_retry', errorCode: failure.code, errorKind: failure.kind,
      errorSummary: failure.summary });
    return;
  }
  const code = ambiguous ? 'delivery_unknown' : failure.code;
  const kind = ambiguous ? 'ambiguous' : failure.kind;
  await client.query(
    `UPDATE ops.outbound_messages SET status='dead_letter',locked_at=NULL,locked_by=NULL,
       last_error_code=$2,last_error_kind=$3,last_error_summary=$4,updated_at=now() WHERE id=$1`,
    [row.id, code, kind, failure.summary],
  );
  await openOutboundDeadLetter(client, row,
    ambiguous ? 'delivery_unknown_requires_human' : 'outbound_retry_exhausted',
    code, kind, failure.summary);
  await recordOutboundEvent(client, { environment: row.environment, outboundId: row.id,
    attempt: row.attempts, fromStatus: 'sending', toStatus: 'dead_letter',
    reason: ambiguous ? 'delivery_unknown_requires_human' : 'retry_exhausted',
    errorCode: code, errorKind: kind, errorSummary: failure.summary });
  if (row.turn_id) await client.query(
    `UPDATE agent.turns SET status='blocked',error_message=$2 WHERE id=$1`,
    [row.turn_id, failure.summary]);
}

export async function pollBotOutbox(): Promise<void> {
  const client = await pool.connect();
  let row: OutboundRow | null = null;
  let readyToSend = false;
  let providerAccepted = false;
  try {
    await client.query('BEGIN');
    await reclaimAmbiguousOutbound(client, env.FAREJADOR_ENV);
    await reconcilePendingAcksFromCore(client, env.FAREJADOR_ENV);
    await markDeliverySuspects(client, env.FAREJADOR_ENV);
    await supersedeStaleAgentOutbound(client, env.FAREJADOR_ENV);
    row = await pickOutboundMessage(client, env.FAREJADOR_ENV);
    await client.query('COMMIT');
    if (!row) return;
    readyToSend = true;
    if (!['agent_text', 'survey_text', 'photo_text', 'photo_attachment'].includes(row.kind)) {
      throw new Error(`unsupported outbound kind: ${row.kind}`);
    }
    const sent = await deliverOutboundRow(client, row);
    providerAccepted = true;
    await client.query('BEGIN');
    await markPhotoRequestSent(client, row);
    await markOutboundAck(client, row, sent.chatwootMessageId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (row && readyToSend) {
      try {
        await client.query('BEGIN');
        const persistedError = providerAccepted
          ? new ChatwootApiError(
            `provider accepted but local persistence failed: ${error instanceof Error ? error.message : 'unknown'}`,
            null,
          )
          : error;
        await markOutboundFailure(client, row, persistedError);
        await client.query('COMMIT');
      } catch (markError) {
        await client.query('ROLLBACK').catch(() => undefined);
        logger.error({ err: markError, outbound_id: row.id }, 'bot outbox: failed to persist failure');
      }
    } else {
      logger.error({ err: error }, 'bot outbox: poll failed');
    }
  } finally {
    client.release();
  }
}

export function startBotOutboxWorker(): () => void {
  if (!env.BOT_OUTBOX) return () => undefined;
  let stopped = false;
  const loop = async (): Promise<void> => {
    if (stopped) return;
    await pollBotOutbox();
    if (!stopped) setTimeout(() => void loop(), POLL_MS);
  };
  void loop();
  logger.info({ worker_id: WORKER_ID }, 'bot outbox worker: started');
  return () => { stopped = true; };
}
