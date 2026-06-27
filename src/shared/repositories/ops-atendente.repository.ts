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

  // Coalescing window: a cada mensagem nova, RESETA o timer de todos os
  // jobs pending da mesma conversa pra now() + debounceSeconds. Isso faz
  // com que o worker so processe quando o cliente parar de digitar por
  // debounceSeconds. Quando finalmente processar, o picker descarta os
  // jobs antigos via hasNewerPendingJob e so o ultimo roda — vendo todas
  // as mensagens da rajada de uma vez via loadHistory.
  //
  // Comportamento:
  //   - 1 msg solta -> espera debounceSeconds e responde
  //   - 3 msgs em rajada -> cada uma reseta o timer -> 1 resposta vendo as 3
  //   - cliente pausa e volta -> reset garante que pega tudo
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

/**
 * Marca job como obsoleto. Reusa status='processed' porque o schema atual nao tem
 * 'superseded' no CHECK constraint, mas registra o motivo em error_message para
 * auditoria. Motivos:
 *  - 'superseded:newer_message_arrived' (default): chegou mensagem mais nova antes
 *    do debounce expirar.
 *  - 'superseded:already_replied_after_trigger': a conversa JÁ teve resposta nossa
 *    depois do gatilho (job requentado pela rede de 60s) — ver isStaleTrigger.
 */
export async function markAtendenteJobSuperseded(
  client: PoolClient,
  jobId: string,
  reason = 'superseded:newer_message_arrived',
): Promise<void> {
  await client.query(
    `UPDATE ops.atendente_jobs
     SET status        = 'processed',
         processed_at  = now(),
         locked_at     = NULL,
         locked_by     = NULL,
         error_message = $2
     WHERE id = $1`,
    [jobId, reason],
  );
}

/**
 * Carrega os dois horários que decidem se um job está "requentado": o horário do GATILHO
 * deste job (a mensagem que o criou) e o horário da mensagem MAIS NOVA que o bot JÁ
 * respondeu na conversa — ou seja, o gatilho do último turn ENTREGUE (agent.turns
 * status='delivered'; delivered_message_id é coluna morta, não confiar nela). A
 * comparação fica em isStaleTrigger (testável).
 *
 * Revisado 06-27: antes o 2º horário era o da última resposta (outgoing) na conversa, o
 * que engolia uma pergunta nova quando a saudação saía atrasada (depois dela). Agora é a
 * mensagem que a resposta DE FATO cobriu, não o relógio. Query burra de propósito, baixo risco.
 */
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
           AND t.status = 'delivered') AS last_answered_trigger_at`,
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
