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
import { deterministicUuid } from '../shared/deterministic-id.js';
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
  maybeAutoChainVerificarEstoque,
  recordToolExecutionResults,
  type ToolExecutionResult,
} from './executor/tool-executor.js';
import { buildPlannerContext } from './planner/context-builder.js';
import { planTurn, recordPlannerDecision, type PlannerDecisionResult } from './planner/service.js';
import { generateTurn, recordGeneratorResult } from './generator/service.js';
import { SAFE_FALLBACK_SAY, type GeneratorResult, type GeneratorRetryContext } from './generator/schemas.js';
import {
  AgentStateVersionConflictError,
  applyActionAndPersistInTx,
} from './state/agent-state.repository.js';
import type { AgentAction, EscalateAction } from '../shared/zod/agent-actions.js';
import { postEscalateNote } from './handlers/escalate.js';
import {
  createDefaultAtendenteJobReconcileInput,
  reconcileMissingAtendenteJobsWithPool,
} from './reconcile-jobs.js';

const WORKER_ID = `atendente-shadow-${randomUUID().slice(0, 8)}`;
const MISSING_STATE_PREFIX = 'planner_context_missing_state:';
const RECONCILE_INTERVAL_MS = 60_000;
let lastReconcileAt = 0;

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
  escalated_actions: EscalateAction[];
}> {
  await lockSessionForJob(client, job);

  const context = await buildPlannerContext(client, job.environment, job.conversation_id, job.trigger_message_id);
  const turnIndex = context.state.turn_index + 1;

  const decision = await planTurn(context);
  await recordPlannerDecision(client, context, decision);

  let toolResults: ToolExecutionResult[] = [];
  if (decision.output.tool_requests.length > 0) {
    toolResults = await executeToolRequests(client, decision.output.tool_requests);
    await recordToolExecutionResults(client, context, toolResults);
  }

  // Auto-chain deterministico: se buscarProduto retornou produto e
  // verificarEstoque ainda nao rodou, dispara verificarEstoque automaticamente.
  // Sem regex sobre a mensagem do cliente — achou produto, confirma estoque.
  const autoStock = await maybeAutoChainVerificarEstoque(
    client,
    job.environment,
    toolResults,
  );
  if (autoStock) {
    toolResults = [...toolResults, autoStock];
    await recordToolExecutionResults(client, context, [autoStock]);
  }

  const generatorResult = await generateTurnWithSelfCorrection(context, decision, toolResults);
  const turnId = await recordGeneratorResult(
    client,
    context,
    decision.output.skill,
    generatorResult,
    job.trigger_message_id,
  );

  // B5: se o Planner decidiu escalar_humano, o worker emite a action `escalate`
  // diretamente (o Generator nao tem permissao de emitir escalate no raw schema).
  // Isso garante que escalation chega no DB e a nota Chatwoot eh disparada,
  // mesmo se o Generator bloquear ou falhar.
  const actionsToApply: AgentAction[] = [];
  const syntheticEscalate = maybeSynthesizeEscalate(
    decision,
    generatorResult,
    context.conversation_id,
    turnIndex,
  );
  if (syntheticEscalate) {
    actionsToApply.push(syntheticEscalate);
  }
  if (!generatorResult.blocked && generatorResult.actions.length > 0) {
    actionsToApply.push(...generatorResult.actions);
  }

  // Sprint 6.5: fechar loop de mutação de estado.
  // Aplica cada action válida, isoladamente via SAVEPOINT — uma falha
  // não derruba auditoria do turno nem outras actions independentes.
  let actionsPersisted = 0;
  let actionsFailed = 0;
  const escalatedActions: EscalateAction[] = [];
  if (actionsToApply.length > 0) {
    let currentState = context.state;
    for (const action of actionsToApply) {
      const savepoint = `apply_${actionsPersisted + actionsFailed}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        currentState = await applyActionAndPersistInTx(client, currentState, action);
        actionsPersisted += 1;
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        if (action.type === 'escalate') {
          escalatedActions.push(action);
        }
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
    escalated_actions: escalatedActions,
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

      // Após COMMIT: efeitos externos que não devem reverter a transação.
      // Falha aqui não desfaz o estado já persistido no banco.
      for (const escalateAction of summary.escalated_actions) {
        await postEscalateNote(client, job.environment, job.conversation_id, escalateAction);
      }

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
      await safeRollback(client, 'after_process_job_failed', { job_id: job.id });

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
        await safeRollback(client, 'after_incident_log_failed', { job_id: job.id });
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
      await safeRollback(client, 'after_poll_failed', {});
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
    await reconcileAtendenteJobsIfDue();
    await pollAndAttend();
    setTimeout(loop, env.ATENDENTE_SHADOW_POLL_INTERVAL_MS);
  }

  void loop();

  return function stop(): void {
    stopped = true;
    logger.info({ worker_id: WORKER_ID }, 'atendente shadow: stopping');
  };
}

async function reconcileAtendenteJobsIfDue(now = new Date()): Promise<void> {
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
        'atendente shadow: reconciled missing jobs',
      );
    }
  } catch (err) {
    logger.error({ worker_id: WORKER_ID, err }, 'atendente shadow: job reconciliation failed');
  }
}

/**
 * B5: gera action `escalate` sintetica quando Planner decidiu escalar_humano.
 *
 * O Generator nao pode emitir `escalate` porque seu raw schema so aceita 4 tipos
 * (update_slot, create_item, record_offer, update_draft). Sem essa funcao, a
 * decisao do Planner virava apenas turn com selected_skill='escalar_humano',
 * sem persistir em agent.escalations nem disparar nota Chatwoot — atendente
 * humano nao era avisado (auditoria achado 1.1, 0 linhas em agent.escalations
 * em prod apos 180 turns com skill='escalar_humano').
 *
 * Reason inferido de sinais disponiveis (planner risk_flags + confidence).
 * Summary preferencialmente a fala que o Generator escreveu; fallback simples
 * quando Generator bloqueou.
 *
 * action_id eh deterministico — retry da mesma decisao nao duplica escalation
 * (ON CONFLICT em session_events.action_id ja garante; syncEscalation tambem
 * tem WHERE NOT EXISTS por motivo+status).
 */
export function maybeSynthesizeEscalate(
  decision: PlannerDecisionResult,
  generatorResult: GeneratorResult,
  conversationId: string,
  turnIndex: number,
): EscalateAction | null {
  if (decision.output.skill !== 'escalar_humano') return null;

  const reason: EscalateAction['reason'] = decision.output.risk_flags.includes('human_requested')
    ? 'customer_requested'
    : decision.output.confidence < 0.3
      ? 'confidence_low'
      : 'other';

  const summary = (() => {
    const sayCandidate = generatorResult.blocked
      ? generatorResult.candidate_say_text
      : generatorResult.say_text;
    if (sayCandidate && sayCandidate.trim().length > 0) return sayCandidate;
    return `Sistema escalou conversa para atendimento humano (skill=escalar_humano, motivo=${reason}).`;
  })();

  const actionId = deterministicUuid([
    'synthetic_escalate',
    conversationId,
    turnIndex,
    reason,
  ]);

  return {
    action_id: actionId,
    turn_index: turnIndex,
    emitted_at: new Date().toISOString(),
    emitted_by: 'system',
    type: 'escalate',
    reason,
    summary_text: summary.slice(0, 2000),
  };
}

/**
 * Executa ROLLBACK e loga explicitamente se falhar (em vez de engolir o erro).
 * Substitui o antigo `.catch(() => {})` mudo: rollback que falha agora aparece
 * no log com contexto, em vez de virar inconsistencia silenciosa.
 */
async function safeRollback(
  client: PoolClient,
  reason: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackErr) {
    logger.error(
      { worker_id: WORKER_ID, rollback_reason: reason, ...context, err: rollbackErr },
      'atendente shadow: ROLLBACK failed (transaction state inconsistent)',
    );
  }
}

/**
 * Self-correction: chama generateTurn uma vez; se vier blocked ou cair em
 * SAFE_FALLBACK_SAY, chama de novo passando retryContext com o motivo.
 * Cap em 1 retry — sem loop infinito.
 *
 * O resultado final (1o atempt se bom, 2o atempt caso contrario) carrega
 * self_correction_round e self_correction_previous_reason pra auditoria.
 */
async function generateTurnWithSelfCorrection(
  context: import('./planner/context-builder.js').PlannerContext,
  decision: PlannerDecisionResult,
  toolResults: ToolExecutionResult[],
): Promise<GeneratorResult> {
  const first = await generateTurn(context, decision, toolResults);

  if (!shouldSelfCorrect(first)) {
    return first;
  }

  const retryContext: GeneratorRetryContext = first.blocked
    ? {
        reason: 'previous_blocked',
        previous_block_reason: first.block_reason,
        previous_candidate_say: first.candidate_say_text,
      }
    : {
        reason: 'previous_fallback',
        previous_say: first.say_text,
      };

  logger.info(
    {
      worker_id: WORKER_ID,
      shadow: true,
      conversation_id: context.conversation_id,
      reason: retryContext.reason,
      first_block_reason: first.block_reason,
      first_say: first.say_text,
    },
    'atendente shadow: self-correction triggered',
  );

  const second = await generateTurn(context, decision, toolResults, retryContext);

  return {
    ...second,
    self_correction_round: 2,
    self_correction_previous_reason:
      retryContext.reason === 'previous_blocked'
        ? first.block_reason
        : 'previous_fallback',
  };
}

function shouldSelfCorrect(result: GeneratorResult): boolean {
  // Path A: validator bloqueou o turn.
  if (result.blocked) return true;
  // Path B: Generator emitiu o texto literal de fallback (sem que validator tenha bloqueado).
  // Usamos igualdade de constante exportada — atualiza junto se SAFE_FALLBACK_SAY mudar.
  if (result.say_text === SAFE_FALLBACK_SAY) return true;
  return false;
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
