import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import {
  enqueueAtendenteJob,
  ensureAtendenteSession,
} from '../shared/repositories/ops-atendente.repository.js';
import type { Environment } from '../shared/types/chatwoot.js';

export interface ReconcileMissingAtendenteJobsInput {
  environment: Environment;
  since: Date;
  until: Date;
  limit: number;
}

export interface ReconciledAtendenteJob {
  conversation_id: string;
  trigger_message_id: string;
  atendente_job_id: string;
  agent_session_id: string;
}

export interface ReconcileMissingAtendenteJobsResult {
  candidates: number;
  reconciled: number;
  jobs: ReconciledAtendenteJob[];
}

interface MissingAtendenteJobRow {
  conversation_id: string;
  message_id: string;
}

export async function findMissingAtendenteJobMessages(
  client: PoolClient,
  input: ReconcileMissingAtendenteJobsInput,
): Promise<MissingAtendenteJobRow[]> {
  const result = await client.query<MissingAtendenteJobRow>(
    `SELECT m.conversation_id,
            m.id AS message_id
     FROM core.messages m
     LEFT JOIN ops.atendente_jobs j
       ON j.environment = m.environment
      AND j.trigger_message_id = m.id
     WHERE m.environment = $1
       AND m.sender_type = 'contact'
       AND m.is_private = false
       AND m.created_at >= $2
       AND m.created_at < $3
       AND j.id IS NULL
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT $4`,
    [input.environment, input.since, input.until, input.limit],
  );

  return result.rows;
}

export async function reconcileMissingAtendenteJobs(
  client: PoolClient,
  input: ReconcileMissingAtendenteJobsInput,
): Promise<ReconcileMissingAtendenteJobsResult> {
  const missingMessages = await findMissingAtendenteJobMessages(client, input);
  const jobs: ReconciledAtendenteJob[] = [];

  for (const message of missingMessages) {
    const agentSessionId = await ensureAtendenteSession(
      client,
      input.environment,
      message.conversation_id,
      message.message_id,
    );
    const atendenteJobId = await enqueueAtendenteJob(
      client,
      input.environment,
      message.conversation_id,
      message.message_id,
    );

    jobs.push({
      conversation_id: message.conversation_id,
      trigger_message_id: message.message_id,
      atendente_job_id: atendenteJobId,
      agent_session_id: agentSessionId,
    });
  }

  return {
    candidates: missingMessages.length,
    reconciled: jobs.length,
    jobs,
  };
}

export async function reconcileMissingAtendenteJobsWithPool(
  input: ReconcileMissingAtendenteJobsInput,
  dbPool: Pool = defaultPool,
): Promise<ReconcileMissingAtendenteJobsResult> {
  const startedAt = Date.now();
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');
    const result = await reconcileMissingAtendenteJobs(client, input);
    await client.query('COMMIT');

    logger.info(
      {
        environment: input.environment,
        since: input.since.toISOString(),
        until: input.until.toISOString(),
        limit: input.limit,
        candidates: result.candidates,
        reconciled: result.reconciled,
        duration_ms: Date.now() - startedAt,
      },
      'atendente jobs reconciliation completed',
    );

    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'atendente jobs reconciliation failed');
    throw err;
  } finally {
    client.release();
  }
}

export function createDefaultAtendenteJobReconcileInput(now = new Date()): ReconcileMissingAtendenteJobsInput {
  return {
    environment: env.FAREJADOR_ENV,
    since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    until: now,
    limit: 100,
  };
}