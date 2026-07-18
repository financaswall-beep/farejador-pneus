/**
 * Repository para ops.atendente_jobs - Sprint 5 (Worker Shadow).
 * Cobre pickup com FOR UPDATE SKIP LOCKED e transicoes de status.
 */

import type { PoolClient } from 'pg';
import type { Environment } from '../types/chatwoot.js';
import type { AtendenteJobStatus } from '../types/ops-phase3.js';
import {
  classifyAtendenteError,
  MAX_ATENDENTE_RETRY_ATTEMPTS,
  retryBackoffSeconds,
  STALE_ATENDENTE_PROCESSING_MINUTES,
} from './ops-atendente-retry.js';
import { openJobDeadLetter, recordAtendenteJobEvent } from './ops-atendente-events.js';

export interface AtendenteJobRow {
  id: string;
  environment: Environment;
  conversation_id: string;
  trigger_message_id: string;
  status: AtendenteJobStatus;
  attempts: number;
  created_at: Date;
}

export async function ensureAtendenteSession(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  triggerMessageId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO agent.session_current
       (environment, conversation_id, last_customer_message_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (environment, conversation_id) DO UPDATE
     SET last_customer_message_id = EXCLUDED.last_customer_message_id,
         updated_at = now()
     RETURNING id`,
    [environment, conversationId, triggerMessageId],
  );
  return result.rows[0]!.id;
}

export async function enqueueAtendenteJob(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  triggerMessageId: string,
  debounceSeconds = 0,
): Promise<string> {
  const result = await client.query<{ enqueue_atendente_job: string }>(
    `SELECT ops.enqueue_atendente_job($1, $2, $3) AS enqueue_atendente_job`,
    [environment, conversationId, triggerMessageId],
  );
  const jobId = result.rows[0]!.enqueue_atendente_job;

  // Reseta o debounce dos jobs pendentes; o picker descarta os antigos.
  if (debounceSeconds > 0) {
    await client.query(
      `UPDATE ops.atendente_jobs
       SET not_before = now() + ($3 || ' seconds')::interval
       WHERE environment = $1
         AND conversation_id = $2
         AND status = 'pending'`,
      [environment, conversationId, String(debounceSeconds)],
    );
  }

  return jobId;
}

/**
 * Verifica se existe job mais recente (pending ou processing) para a mesma
 * conversa. Usado pelo worker pra descartar jobs obsoletos quando o cliente
 * mandou mais mensagens enquanto o job estava aguardando o debounce.
 */
export async function hasNewerPendingJob(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  afterCreatedAt: Date,
  excludeJobId: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM ops.atendente_jobs
       WHERE environment = $1
         AND conversation_id = $2
         AND id <> $3
         AND status IN ('pending', 'processing')
         AND created_at > $4
     ) AS exists`,
    [environment, conversationId, excludeJobId, afterCreatedAt],
  );
  return result.rows[0]?.exists === true;
}

/** Com a flag nova, usa status superseded; no legado preserva processed. */
export async function markAtendenteJobSuperseded(
  client: PoolClient,
  jobId: string,
  reason = 'superseded:newer_message_arrived',
  explicitStatus = false,
): Promise<void> {
  await client.query(
    `UPDATE ops.atendente_jobs
     SET status        = $3,
         processed_at  = now(),
         locked_at     = NULL,
         locked_by     = NULL,
         error_message = $2
     WHERE id = $1`,
    [jobId, reason, explicitStatus ? 'superseded' : 'processed'],
  );
}

/** Compara o gatilho atual ao último gatilho efetivamente respondido pelo bot. */
export async function loadStaleTriggerCheck(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  triggerMessageId: string,
): Promise<{ thisTriggerAt: Date | null; lastAnsweredTriggerAt: Date | null }> {
  const result = await client.query<{
    this_trigger_at: Date | null;
    last_answered_trigger_at: Date | null;
  }>(
    `SELECT
       (SELECT created_at FROM core.messages WHERE id = $3) AS this_trigger_at,
       (SELECT max(m.created_at)
          FROM agent.turns t
          JOIN core.messages m ON m.id = t.trigger_message_id AND m.environment = t.environment
         WHERE t.environment = $1
           AND t.conversation_id = $2
           AND t.status IN ('delivered', 'sent_api_ack')) AS last_answered_trigger_at`,
    [environment, conversationId, triggerMessageId],
  );
  const row = result.rows[0];
  return {
    thisTriggerAt: row?.this_trigger_at ?? null,
    lastAnsweredTriggerAt: row?.last_answered_trigger_at ?? null,
  };
}

export async function pickAtendenteJob(
  client: PoolClient,
  environment: Environment,
): Promise<AtendenteJobRow | null> {
  const result = await client.query<AtendenteJobRow>(
    `SELECT id, environment, conversation_id, trigger_message_id, status, attempts, created_at
     FROM ops.atendente_jobs
     WHERE environment = $1
       AND status = 'pending'
       AND not_before <= now()
     ORDER BY not_before
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [environment],
  );
  return result.rows[0] ?? null;
}

export async function reclaimStaleAtendenteJobs(
  client: PoolClient,
  environment: Environment,
  resilienceEnabled = false,
): Promise<number> {
  const terminalStatus = resilienceEnabled ? 'dead_letter' : 'failed';
  const result = await client.query<{ id: string; attempts: number; status: string }>(
    `UPDATE ops.atendente_jobs
     SET status = CASE WHEN attempts < $2 THEN 'pending' ELSE $4 END,
         not_before = CASE
           WHEN attempts < $2 THEN now() + interval '1 minute'
           ELSE not_before
         END,
         locked_at = NULL,
         locked_by = NULL,
         error_message = CASE
           WHEN attempts < $2 THEN 'reclaimed:stale_processing'
           ELSE 'dead_letter_candidate:stale_processing_max_attempts'
         END,
         processed_at = CASE WHEN attempts < $2 THEN NULL ELSE now() END
         ${resilienceEnabled ? ", dead_lettered_at = CASE WHEN attempts < $2 THEN NULL ELSE now() END, last_error_code = 'stale_processing', last_error_kind = 'timeout'" : ''}
     WHERE environment = $1
       AND status = 'processing'
       AND locked_at < now() - ($3 || ' minutes')::interval
     RETURNING id, attempts, status`,
    [environment, MAX_ATENDENTE_RETRY_ATTEMPTS,
      String(STALE_ATENDENTE_PROCESSING_MINUTES), terminalStatus],
  );
  if (resilienceEnabled) {
    for (const row of result.rows) {
      const terminal = row.status === 'dead_letter';
      const event = { environment, jobId: row.id, attempt: row.attempts,
        fromStatus: 'processing', toStatus: row.status,
        reason: terminal ? 'stale_processing_retry_limit' : 'stale_processing_reclaimed',
        errorCode: 'stale_processing', errorKind: 'timeout',
        errorSummary: terminal ? 'worker_stopped_after_retry_limit' : 'worker_lock_expired' };
      await recordAtendenteJobEvent(client, event);
      if (terminal) await openJobDeadLetter(client, event);
    }
  }
  return result.rowCount ?? 0;
}

export async function markAtendenteJobProcessing(
  client: PoolClient,
  jobId: string,
  workerId: string,
): Promise<void> {
  await client.query(
    `UPDATE ops.atendente_jobs
     SET status     = 'processing',
         locked_at  = now(),
         locked_by  = $2,
         attempts   = attempts + 1
     WHERE id = $1`,
    [jobId, workerId],
  );
}

export async function markAtendenteJobProcessed(
  client: PoolClient,
  jobId: string,
): Promise<void> {
  await client.query(
    `UPDATE ops.atendente_jobs
     SET status        = 'processed',
         processed_at  = now(),
         locked_at     = NULL,
         locked_by     = NULL,
         error_message = NULL
     WHERE id = $1`,
    [jobId],
  );
}

export async function markAtendenteJobFailed(
  client: PoolClient,
  jobId: string,
  error: unknown,
  resilienceEnabled = false,
): Promise<void> {
  const current = await client.query<{ attempts: number; environment: Environment }>(
    `SELECT attempts, environment FROM ops.atendente_jobs WHERE id = $1 FOR UPDATE`,
    [jobId],
  );
  const attempts = current.rows[0]?.attempts ?? MAX_ATENDENTE_RETRY_ATTEMPTS;
  const environment = current.rows[0]?.environment;
  const failure = classifyAtendenteError(error);
  if (attempts < MAX_ATENDENTE_RETRY_ATTEMPTS && failure.retryable) {
    await client.query(
      `UPDATE ops.atendente_jobs
       SET status        = 'pending',
           processed_at  = NULL,
           locked_at     = NULL,
           locked_by     = NULL,
           not_before    = now() + ($3 || ' seconds')::interval,
           error_message = $2${resilienceEnabled ? ', last_error_code = $4, last_error_kind = $5' : ''}
       WHERE id = $1`,
      resilienceEnabled
        ? [jobId, failure.summary, String(retryBackoffSeconds(attempts + 1)), failure.code, failure.kind]
        : [jobId, failure.summary, String(retryBackoffSeconds(attempts + 1))],
    );
    if (resilienceEnabled && environment) await recordAtendenteJobEvent(client, {
      environment, jobId, attempt: attempts, fromStatus: 'processing', toStatus: 'pending',
      reason: 'automatic_retry', errorCode: failure.code, errorKind: failure.kind,
      errorSummary: failure.summary,
    });
    return;
  }

  const terminalStatus = resilienceEnabled ? 'dead_letter' : 'failed';
  await client.query(
    `UPDATE ops.atendente_jobs
     SET status        = $3,
         processed_at  = now(),
         locked_at     = NULL,
         locked_by     = NULL,
         error_message = $2${resilienceEnabled ? ', last_error_code = $4, last_error_kind = $5, dead_lettered_at = now()' : ''}
     WHERE id = $1`,
    resilienceEnabled
      ? [jobId, failure.summary, terminalStatus, failure.code, failure.kind]
      : [jobId, failure.summary, terminalStatus],
  );
  if (resilienceEnabled && environment) {
    const event = { environment, jobId, attempt: attempts, fromStatus: 'processing',
      toStatus: terminalStatus, reason: failure.retryable ? 'retry_limit_reached' : 'permanent_failure',
      errorCode: failure.code, errorKind: failure.kind, errorSummary: failure.summary };
    await recordAtendenteJobEvent(client, event);
    await openJobDeadLetter(client, event);
  }
}
