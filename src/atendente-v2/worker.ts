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
  hasNewerPendingJob,
  loadStaleTriggerCheck,
  markAtendenteJobFailed,
  markAtendenteJobProcessed,
  markAtendenteJobProcessing,
  markAtendenteJobSuperseded,
  pickAtendenteJob,
  reclaimStaleAtendenteJobs,
} from '../shared/repositories/ops-atendente.repository.js';
import { isStaleTrigger } from './stale-trigger.js';
import { recordAtendenteJobEvent } from '../shared/repositories/ops-atendente-events.js';
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

    const reclaimed = await reclaimStaleAtendenteJobs(
      client,
      env.FAREJADOR_ENV,
      env.BOT_OUTBOX,
    );
    if (reclaimed > 0) {
      logger.warn({ worker_id: WORKER_ID, reclaimed }, 'agent_v2: reclaimed stale processing jobs');
    }

    const job = await pickAtendenteJob(client, env.FAREJADOR_ENV);
    if (!job) {
      await client.query('COMMIT');
      return;
    }

    logger.info(
      { worker_id: WORKER_ID, job_id: job.id, conversation_id: job.conversation_id },
      'agent_v2: picked job',
    );

    // Debounce: descarta este job se chegou mensagem mais nova durante o
    // intervalo not_before. Evita responder 3x quando cliente manda 3
    // mensagens em sequencia rapida.
    const superseded = await hasNewerPendingJob(
      client,
      job.environment,
      job.conversation_id,
      job.created_at,
      job.id,
    );
    if (superseded) {
      await markAtendenteJobSuperseded(client, job.id, 'superseded:newer_message_arrived', env.BOT_OUTBOX);
      if (env.BOT_OUTBOX) await recordAtendenteJobEvent(client, {
        environment: job.environment, jobId: job.id, attempt: job.attempts,
        fromStatus: job.status, toStatus: 'superseded', reason: 'newer_message_arrived',
      });
      await client.query('COMMIT');
      logger.info(
        { worker_id: WORKER_ID, job_id: job.id, conversation_id: job.conversation_id },
        'agent_v2: job superseded (newer message arrived)',
      );
      return;
    }

    // Trava anti-requentado: se a conversa JÁ teve resposta nossa DEPOIS do
    // gatilho, este job é obsoleto (reenfileirado tarde pela rede de 60s) —
    // responder de novo faria o bot repetir fora de contexto (Vitor 06-15).
    // Decisão Wallace 06-16: melhor atrasar do que repetir.
    const staleCheck = await loadStaleTriggerCheck(
      client,
      job.environment,
      job.conversation_id,
      job.trigger_message_id,
    );
    if (isStaleTrigger(staleCheck.thisTriggerAt, staleCheck.lastAnsweredTriggerAt)) {
      await markAtendenteJobSuperseded(client, job.id, 'superseded:already_replied_after_trigger', env.BOT_OUTBOX);
      if (env.BOT_OUTBOX) await recordAtendenteJobEvent(client, {
        environment: job.environment, jobId: job.id, attempt: job.attempts,
        fromStatus: job.status, toStatus: 'superseded', reason: 'already_replied_after_trigger',
      });
      await client.query('COMMIT');
      logger.info(
        { worker_id: WORKER_ID, job_id: job.id, conversation_id: job.conversation_id },
        'agent_v2: job superseded (already replied after trigger)',
      );
      return;
    }

    await markAtendenteJobProcessing(client, job.id, WORKER_ID);
    if (env.BOT_OUTBOX) await recordAtendenteJobEvent(client, {
      environment: job.environment, jobId: job.id, actor: WORKER_ID,
      attempt: job.attempts + 1, fromStatus: 'pending', toStatus: 'processing', reason: 'picked',
    });
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
      if (env.BOT_OUTBOX) await recordAtendenteJobEvent(client, {
        environment: job.environment, jobId: job.id, actor: WORKER_ID,
        attempt: job.attempts + 1, fromStatus: 'processing', toStatus: 'processed', reason: 'completed',
      });
      await client.query('COMMIT');
      logger.info(
        { worker_id: WORKER_ID, job_id: job.id, conversation_id: job.conversation_id },
        'agent_v2: job processed',
      );
    } catch (err) {
      try {
        await client.query('BEGIN');
        await markAtendenteJobFailed(client, job.id, err, env.BOT_OUTBOX);
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
