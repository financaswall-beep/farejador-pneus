/**
 * Agent V2 Worker.
 *
 * Substitui o antigo `atendente shadow worker` que hospedava o pipeline V1
 * (Planner + Generator + Organizadora). Aqui é tudo V2: 1 LLM com function
 * calling, sem slots, sem Organizadora.
 *
 * Responsabilidades:
 * - Poll da fila ops.atendente_jobs
 * - Reconcile periódico de mensagens sem job
 * - Executa runAgentV2 e marca o job como processed/failed
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import {
  markAtendenteJobFailed,
  markAtendenteJobProcessed,
  markAtendenteJobProcessing,
  pickAtendenteJob,
} from '../shared/repositories/ops-atendente.repository.js';
import {
  createDefaultAtendenteJobReconcileInput,
  reconcileMissingAtendenteJobsWithPool,
} from '../atendente/reconcile-jobs.js';
import { runAgentV2 } from './agent.js';

const WORKER_ID = `agent-v2-${randomUUID().slice(0, 8)}`;
const RECONCILE_INTERVAL_MS = 60_000;
let lastReconcileAt = 0;

export async function pollAndAttend(): Promise<void> {
  let client: PoolClient | null = null;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const job = await pickAtendenteJob(client, env.FAREJADOR_ENV);
    if (!job) {
      await client.query('COMMIT');
      return;
    }

    logger.info(
      { worker_id: WORKER_ID, job_id: job.id, conversation_id: job.conversation_id },
      'agent_v2: picked job',
    );

    await markAtendenteJobProcessing(client, job.id, WORKER_ID);
    await client.query('COMMIT');

    try {
      await runAgentV2({
        jobId: job.id,
        conversationId: job.conversation_id,
        triggerMessageId: job.trigger_message_id,
        environment: job.environment,
      });
      await client.query('BEGIN');
      await markAtendenteJobProcessed(client, job.id);
      await client.query('COMMIT');
      logger.info(
        { worker_id: WORKER_ID, job_id: job.id, conversation_id: job.conversation_id },
        'agent_v2: job processed',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await client.query('BEGIN');
        await markAtendenteJobFailed(client, job.id, message);
        await client.query('COMMIT');
      } catch (markErr) {
        logger.error(
          { worker_id: WORKER_ID, job_id: job.id, err: markErr },
          'agent_v2: failed to mark job failed',
        );
      }
      logger.error(
        { worker_id: WORKER_ID, job_id: job.id, conversation_id: job.conversation_id, err },
        'agent_v2: job failed',
      );
    }
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ worker_id: WORKER_ID, err: rollbackErr }, 'agent_v2: rollback failed');
      }
    }
    logger.error({ err }, 'agent_v2: poll failed');
  } finally {
    client?.release();
  }
}

export function startAgentV2Worker(): () => void {
  if (!env.AGENT_V2_WORKER_ENABLED) {
    logger.info('agent_v2 worker: disabled (AGENT_V2_WORKER_ENABLED=false)');
    return () => {};
  }

  logger.info(
    { worker_id: WORKER_ID, poll_interval_ms: env.AGENT_V2_POLL_INTERVAL_MS },
    'agent_v2 worker: starting',
  );

  let stopped = false;

  async function loop(): Promise<void> {
    if (stopped) return;
    await reconcileJobsIfDue();
    await pollAndAttend();
    setTimeout(loop, env.AGENT_V2_POLL_INTERVAL_MS);
  }

  void loop();

  return function stop(): void {
    stopped = true;
    logger.info({ worker_id: WORKER_ID }, 'agent_v2 worker: stopping');
  };
}

async function reconcileJobsIfDue(now = new Date()): Promise<void> {
  if (now.getTime() - lastReconcileAt < RECONCILE_INTERVAL_MS) {
    return;
  }

  lastReconcileAt = now.getTime();
  try {
    const result = await reconcileMissingAtendenteJobsWithPool(
      createDefaultAtendenteJobReconcileInput(now),
    );
    if (result.reconciled > 0) {
      logger.warn(
        {
          worker_id: WORKER_ID,
          reconciled: result.reconciled,
          candidates: result.candidates,
        },
        'agent_v2 worker: reconciled missing jobs',
      );
    }
  } catch (err) {
    logger.error({ worker_id: WORKER_ID, err }, 'agent_v2 worker: job reconciliation failed');
  }
}
