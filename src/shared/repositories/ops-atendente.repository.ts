/**
 * Repository para ops.atendente_jobs - Sprint 5 (Worker Shadow).
 * Cobre pickup com FOR UPDATE SKIP LOCKED e transicoes de status.
 */

import type { PoolClient } from 'pg';
import type { Environment } from '../types/chatwoot.js';
import type { AtendenteJobStatus } from '../types/ops-phase3.js';

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

  // Empurra not_before pra +debounceSeconds. Se chegarem mais mensagens
  // do cliente nesse intervalo, novos jobs sao enfileirados — o picker
  // depois descarta os mais antigos via hasNewerPendingJob.
  if (debounceSeconds > 0) {
    await client.query(
      `UPDATE ops.atendente_jobs
       SET not_before = now() + ($2 || ' seconds')::interval
       WHERE id = $1 AND status = 'pending'`,
      [jobId, String(debounceSeconds)],
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

/**
 * Marca job como obsoleto (uma mensagem mais nova chegou antes do debounce
 * expirar). Reusa status='processed' porque o schema atual nao tem
 * 'superseded' no CHECK constraint, mas registra em error_message para
 * auditoria.
 */
export async function markAtendenteJobSuperseded(
  client: PoolClient,
  jobId: string,
): Promise<void> {
  await client.query(
    `UPDATE ops.atendente_jobs
     SET status        = 'processed',
         processed_at  = now(),
         locked_at     = NULL,
         locked_by     = NULL,
         error_message = 'superseded:newer_message_arrived'
     WHERE id = $1`,
    [jobId],
  );
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
  errorMessage: string,
): Promise<void> {
  await client.query(
    `UPDATE ops.atendente_jobs
     SET status        = 'failed',
         processed_at  = now(),
         locked_at     = NULL,
         locked_by     = NULL,
         error_message = $2
     WHERE id = $1`,
    [jobId, errorMessage.slice(0, 1000)],
  );
}
