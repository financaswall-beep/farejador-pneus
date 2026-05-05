/**
 * Atendente Worker Shadow - Sprint 6.
 *
 * Fluxo: Context Builder -> Planner -> Tool Executor -> Generator Shadow -> auditoria.
 *
 * Limites desta sprint:
 * - sem envio Chatwoot;
 * - sem atendimento automático ao cliente.
 * - worker desligado por default.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { logIncident } from '../shared/repositories/ops-phase3.repository.js';
import type { IncidentSeverity, IncidentType } from '../shared/types/ops-phase3.js';
import {
  markAtendenteJobFailed,
  markAtendenteJobProcessed,
  markAtendenteJobProcessing,
  pickAtendenteJob,
  type AtendenteJobRow,
} from '../shared/repositories/ops-atendente.repository.js';
import {
  executeToolRequests,
  recordToolExecutionResults,
  type ToolExecutionResult,
} from './executor/tool-executor.js';
import { buildPlannerContext } from './planner/context-builder.js';
import { planTurn, recordPlannerDecision } from './planner/service.js';
import { generateTurn, recordGeneratorResult } from './generator/service.js';
import {
  AgentStateVersionConflictError,
  applyActionAndPersistInTx,
} from './state/agent-state.repository.js';

const WORKER_ID = `atendente-shadow-${randomUUID().slice(0, 8)}`;
const MISSING_STATE_PREFIX = 'planner_context_missing_state:';

export function classifyJobFailure(error: unknown): {
  incident_type: IncidentType;
  severity: IncidentSeverity;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(MISSING_STATE_PREFIX)) {
    return { incident_type: 'context_build_failed', severity: 'medium', message };
  }
  return { incident_type: 'action_handler_failed', severity: 'high', message };
}

export async function processAtendenteJob(
  client: PoolClient,
  job: AtendenteJobRow,
): Promise<{
  skill: string;
  used_llm: boolean;
  fallback_used: boolean;
  turn_index: number;
  tool_results: ToolExecutionResult[];
  generator_blocked: boolean;
  generator_block_reason: string | null;
  turn_id: string;
  actions_persisted: number;
  actions_failed: number;
}> {
  await lockSessionForJob(client, job);

  const context = await buildPlannerContext(client, job.environment, job.conversation_id);
  const turnIndex = context.state.turn_index + 1;

  const decision = await planTurn(context);
  await recordPlannerDecision(client, context, decision);

  let toolResults: ToolExecutionResult[] = [];
  if (decision.output.tool_requests.length > 0) {
    toolResults = await executeToolRequests(client, decision.output.tool_requests);
    await recordToolExecutionResults(client, context, toolResults);
  }

  const generatorResult = await generateTurn(context, decision, toolResults);
  const turnId = await recordGeneratorResult(
    client,
    context,
    decision.output.skill,
    generatorResult,
    job.trigger_message_id,
  );

  // Sprint 6.5: fechar loop de mutação de estado.
  // Aplica cada action válida, isoladamente via SAVEPOINT — uma falha
  // não derruba auditoria do turno nem outras actions independentes.
  let actionsPersisted = 0;
  let actionsFailed = 0;
  if (!generatorResult.blocked && generatorResult.actions.length > 0) {
    let currentState = context.state;
    for (const action of generatorResult.actions) {
      const savepoint = `apply_${actionsPersisted + actionsFailed}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        currentState = await applyActionAndPersistInTx(client, currentState, action);
        actionsPersisted += 1;
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (err) {
        actionsFailed += 1;
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        const message = err instanceof Error ? err.message : String(err);
        const isVersionConflict = err instanceof AgentStateVersionConflictError;
        logger.warn(
          {
            worker_id: WORKER_ID,
            shadow: true,
            conversation_id: job.conversation_id,
            turn_id: turnId,
            action_type: action.type,
            action_id: 'action_id' in action ? action.action_id : undefined,
            version_conflict: isVersionConflict,
            error: message,
          },
          'atendente shadow: action persist failed (continuing)',
        );
        // Em conflito de versão, recarregamos pra próximas actions usarem version atual.
        if (isVersionConflict) {
          break;
        }
      }
    }
  }

  await markShadowTurnProcessed(client, job, turnIndex);

  return {
    skill: decision.output.skill,
    used_llm: decision.used_llm || generatorResult.used_llm,
    fallback_used: decision.fallback_used || generatorResult.fallback_used,
    turn_index: turnIndex,
    tool_results: toolResults,
    generator_blocked: generatorResult.blocked,
    generator_block_reason: generatorResult.block_reason,
    turn_id: turnId,
    actions_persisted: actionsPersisted,
    actions_failed: actionsFailed,
  };
}

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
      'atendente shadow: picked job',
    );

    await markAtendenteJobProcessing(client, job.id, WORKER_ID);
    await client.query('COMMIT');

    try {
      await client.query('BEGIN');
      const summary = await processAtendenteJob(client, job);
      await markAtendenteJobProcessed(client, job.id);
      await client.query('COMMIT');

      logger.info(
        {
          worker_id: WORKER_ID,
          shadow: true,
          job_id: job.id,
          conversation_id: job.conversation_id,
          trigger_message_id: job.trigger_message_id,
          turn_index: summary.turn_index,
          skill: summary.skill,
          used_llm: summary.used_llm,
          fallback_used: summary.fallback_used,
          tool_count: summary.tool_results.length,
          tool_failures: summary.tool_results.filter((result) => !result.ok).length,
          generator_blocked: summary.generator_blocked,
          generator_block_reason: summary.generator_block_reason,
          actions_persisted: summary.actions_persisted,
          actions_failed: summary.actions_failed,
          turn_id: summary.turn_id,
        },
        'atendente shadow: job processed',
        // Sem envio Chatwoot — log-only.
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});

      const failure = classifyJobFailure(err);
      try {
        await client.query('BEGIN');
        await logIncident(client, {
          environment: job.environment,
          conversation_id: job.conversation_id,
          agent_turn_id: null,
          incident_type: failure.incident_type,
          severity: failure.severity,
          details: {
            job_id: job.id,
            trigger_message_id: job.trigger_message_id,
            error: failure.message,
            shadow: true,
          },
        });
        await markAtendenteJobFailed(client, job.id, failure.message);
        await client.query('COMMIT');
      } catch (auditErr) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error(
          { worker_id: WORKER_ID, job_id: job.id, err: auditErr },
          'atendente shadow: failed to record incident/mark failed',
        );
      }

      logger.error(
        {
          worker_id: WORKER_ID,
          shadow: true,
          job_id: job.id,
          conversation_id: job.conversation_id,
          incident_type: failure.incident_type,
          err,
        },
        'atendente shadow: job failed',
      );
    }
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    logger.error({ err }, 'atendente shadow: poll failed');
  } finally {
    client?.release();
  }
}

export function startAtendenteShadow(): () => void {
  if (!env.ATENDENTE_SHADOW_ENABLED) {
    logger.info('atendente shadow: disabled (ATENDENTE_SHADOW_ENABLED=false)');
    return () => {};
  }

  logger.info(
    {
      worker_id: WORKER_ID,
      poll_interval_ms: env.ATENDENTE_SHADOW_POLL_INTERVAL_MS,
      planner_llm_enabled: env.PLANNER_LLM_ENABLED,
      generator_llm_enabled: env.GENERATOR_LLM_ENABLED,
    },
    'atendente shadow: starting',
  );

  let stopped = false;

  async function loop(): Promise<void> {
    if (stopped) return;
    await pollAndAttend();
    setTimeout(loop, env.ATENDENTE_SHADOW_POLL_INTERVAL_MS);
  }

  void loop();

  return function stop(): void {
    stopped = true;
    logger.info({ worker_id: WORKER_ID }, 'atendente shadow: stopping');
  };
}

async function lockSessionForJob(client: PoolClient, job: AtendenteJobRow): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM agent.session_current
     WHERE environment = $1
       AND conversation_id = $2
     FOR UPDATE`,
    [job.environment, job.conversation_id],
  );

  if (!result.rowCount || result.rowCount < 1) {
    throw new Error(`${MISSING_STATE_PREFIX}${job.conversation_id}`);
  }
}

async function markShadowTurnProcessed(
  client: PoolClient,
  job: AtendenteJobRow,
  turnIndex: number,
): Promise<void> {
  await client.query(
    `UPDATE agent.session_current
     SET turn_index = GREATEST(turn_index, $3),
         last_customer_message_id = $4,
         updated_at = now()
     WHERE environment = $1
       AND conversation_id = $2`,
    [job.environment, job.conversation_id, turnIndex, job.trigger_message_id],
  );
}
