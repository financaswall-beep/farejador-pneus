import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { recordAtendenteJobEvent } from '../../shared/repositories/ops-atendente-events.js';
import { recordOutboundEvent } from '../../atendente-v2/outbound-events.js';

export interface BotResiliencePayload {
  enabled: boolean;
  pending: number;
  api_ack_unconfirmed: number;
  dead_letters: Array<{ id: string; job_id: string | null; outbound_id: string | null;
    chatwoot_conversation_id: string | null; reason: string; error_code: string | null;
    error_kind: string | null; error_summary: string | null; created_at: string }>;
}

export async function getBotResilienceCounts(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ enabled: boolean; pending: number; apiAckUnconfirmed: number; deadLetters: number }> {
  if (!env.BOT_OUTBOX) return { enabled: false, pending: 0, apiAckUnconfirmed: 0, deadLetters: 0 };
  const result = await dbPool.query<{
    pending: number; api_ack_unconfirmed: number; dead_letters: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM ops.outbound_messages
         WHERE environment=$1 AND status IN ('pending','failed','sending')) AS pending,
       (SELECT count(*)::int FROM ops.outbound_messages
         WHERE environment=$1 AND status='sent_api_ack'
           AND delivery_suspect_at IS NOT NULL) AS api_ack_unconfirmed,
       (SELECT count(*)::int FROM ops.atendente_dead_letters
         WHERE environment=$1 AND resolved_at IS NULL) AS dead_letters`,
    [environment],
  );
  const row = result.rows[0];
  return { enabled: true, pending: row?.pending ?? 0,
    apiAckUnconfirmed: row?.api_ack_unconfirmed ?? 0, deadLetters: row?.dead_letters ?? 0 };
}

export async function getBotResilience(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<BotResiliencePayload> {
  if (!env.BOT_OUTBOX) return { enabled: false, pending: 0, api_ack_unconfirmed: 0, dead_letters: [] };
  const counts = await getBotResilienceCounts(environment, dbPool);
  const dead = await dbPool.query<BotResiliencePayload['dead_letters'][number]>(
    `SELECT d.id,d.job_id,d.outbound_id,cv.chatwoot_conversation_id::text,
            d.reason,d.error_code,d.error_kind,d.error_summary,d.created_at::text
       FROM ops.atendente_dead_letters d
       LEFT JOIN core.conversations cv ON cv.id=d.conversation_id AND cv.environment=d.environment
      WHERE d.environment=$1 AND d.resolved_at IS NULL
      ORDER BY d.created_at DESC LIMIT 50`, [environment]);
  return { enabled: true, pending: counts.pending,
    api_ack_unconfirmed: counts.apiAckUnconfirmed,
    dead_letters: dead.rows };
}

export async function reprocessBotDeadLetter(
  input: { id: string; actor: string; reason: string; risk_confirmed: boolean;
    environment?: 'prod' | 'test' }, dbPool: Pool = defaultPool,
): Promise<{ reprocessed: true; target: 'job' | 'outbound' }> {
  if (!input.risk_confirmed) throw new Error('bot_reprocess_risk_confirmation_required');
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const actor = input.actor.trim().slice(0, 200);
  const reason = input.reason.trim().slice(0, 500);
  if (!actor || reason.length < 5) throw new Error('bot_reprocess_actor_reason_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const letter = await client.query<{ job_id: string | null; outbound_id: string | null }>(
      `SELECT job_id,outbound_id FROM ops.atendente_dead_letters
        WHERE environment=$1 AND id=$2 AND resolved_at IS NULL FOR UPDATE`,
      [environment, input.id]);
    const row = letter.rows[0];
    if (!row) throw new Error('bot_dead_letter_not_found');
    let target: 'job' | 'outbound';
    if (row.outbound_id) {
      target = 'outbound';
      const requeued = await client.query(
        `UPDATE ops.outbound_messages SET status='pending',attempts=0,not_before=now(),
           locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_kind=NULL,
           last_error_summary=NULL,updated_at=now()
          WHERE environment=$1 AND id=$2 AND status='dead_letter'`,
        [environment, row.outbound_id]);
      if (requeued.rowCount !== 1) throw new Error('bot_dead_letter_target_not_requeueable');
      await recordOutboundEvent(client, { environment, outboundId: row.outbound_id,
        actor, reason, fromStatus: 'dead_letter', toStatus: 'pending' });
    } else if (row.job_id) {
      target = 'job';
      const requeued = await client.query(
        `UPDATE ops.atendente_jobs SET status='pending',attempts=0,not_before=now(),
           locked_at=NULL,locked_by=NULL,processed_at=NULL,dead_lettered_at=NULL,
           error_message=NULL,last_error_code=NULL,last_error_kind=NULL
          WHERE environment=$1 AND id=$2 AND status='dead_letter'`,
        [environment, row.job_id]);
      if (requeued.rowCount !== 1) throw new Error('bot_dead_letter_target_not_requeueable');
      await recordAtendenteJobEvent(client, { environment, jobId: row.job_id,
        actor, reason, fromStatus: 'dead_letter', toStatus: 'pending' });
    } else throw new Error('bot_dead_letter_target_missing');
    await client.query(
      `UPDATE ops.atendente_dead_letters SET resolved_at=now(),resolved_by=$3
        WHERE environment=$1 AND id=$2`, [environment, input.id, `${actor}: ${reason}`]);
    await client.query('COMMIT');
    return { reprocessed: true, target };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function resolveBotDeadLetter(
  input: { id: string; actor: string; reason: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ resolved: true }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const actor = input.actor.trim().slice(0, 200);
  const reason = input.reason.trim().slice(0, 500);
  if (!actor || reason.length < 5) throw new Error('bot_resolve_actor_reason_required');
  const result = await dbPool.query(
    `UPDATE ops.atendente_dead_letters SET resolved_at=now(),resolved_by=$3
      WHERE environment=$1 AND id=$2 AND resolved_at IS NULL`,
    [environment, input.id, `${actor}: ${reason}`]);
  if (result.rowCount !== 1) throw new Error('bot_dead_letter_not_found');
  return { resolved: true };
}
