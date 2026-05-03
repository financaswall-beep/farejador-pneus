/**
 * Organizadora Worker — Fase 3.
 *
 * Loop:
 *   1. Pega job da fila (ops.enrichment_jobs FOR UPDATE SKIP LOCKED)
 *   2. Busca mensagens da conversa
 *   3. Monta prompt e chama OpenAI
 *   4. Valida resposta com parseOrganizadoraResponse()
 *   5. Para cada fact: valida fact_value, grava em conversation_facts + fact_evidence
 *   6. Marca job como done (ou failed)
 *   7. Erros estruturais viram ops.agent_incidents (schema_violation, llm_timeout, etc.)
 *
 * Princípio sagrado: Organizadora NUNCA escreve em raw.* ou core.*.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { callOpenAI } from '../shared/llm-clients/openai.js';
import {
  pickEnrichmentJob,
  markJobRunning,
  markJobDone,
  markJobFailed,
  logIncident,
} from '../shared/repositories/ops-phase3.repository.js';
import {
  writeFactWithEvidence,
} from '../shared/repositories/analytics-phase3.repository.js';
import {
  listMessagesForOrganizadora,
  getContactByConversationId,
} from '../shared/repositories/core-reader.repository.js';
import { buildOrganizadoraPrompt, EXTRACTOR_VERSION, SCHEMA_VERSION } from './prompt.js';
import { inferDeterministicFacts } from './deterministic-facts.js';
import { parseOrganizadoraResponse } from '../shared/zod/llm-organizadora.js';
import type { ExtractedFact } from '../shared/zod/llm-organizadora.js';
import { validateFactValue } from '../shared/zod/fact-keys.js';
import type { IncidentInsert } from '../shared/repositories/ops-phase3.repository.js';
import { validateFactEvidence } from './evidence.js';

const WORKER_ID = `organizadora-${randomUUID().slice(0, 8)}`;
const EXTRACTOR_SOURCE = 'llm_openai_organizadora_v1';
const MIN_CONFIDENCE = 0.55;

type FactForWrite = ExtractedFact & { source?: string };

async function logIncidentCommitted(incident: IncidentInsert): Promise<void> {
  const incidentClient = await pool.connect();
  try {
    await incidentClient.query('BEGIN');
    await logIncident(incidentClient, incident);
    await incidentClient.query('COMMIT');
  } catch (err) {
    await incidentClient.query('ROLLBACK').catch(() => {});
    logger.error({ err, incident_type: incident.incident_type }, 'organizadora: failed to persist incident');
  } finally {
    incidentClient.release();
  }
}

// ------------------------------------------------------------------
// Processamento de um job
// ------------------------------------------------------------------

async function processJob(
  client: PoolClient,
  environment: Environment,
  jobId: string,
  conversationId: string,
): Promise<void> {
  // 1. Buscar mensagens
  const messages = await listMessagesForOrganizadora(client, environment, conversationId);

  if (messages.length === 0) {
    logger.info({ job_id: jobId, conversation_id: conversationId }, 'organizadora: no messages, skipping');
    await markJobDone(client, jobId, null);
    return;
  }

  const lastMessageId = messages[messages.length - 1]!.id;

  // 2. Buscar contexto do contato (opcional)
  const contact = await getContactByConversationId(client, environment, conversationId);

  // 3. Montar prompt e chamar LLM
  const promptMessages = buildOrganizadoraPrompt(messages, {
    contactName: contact?.name,
    contactCity: contact?.city,
  });

  const llmStart = Date.now();
  let llmResult: Awaited<ReturnType<typeof callOpenAI>>;

  try {
    llmResult = await callOpenAI({
      apiKey: env.OPENAI_API_KEY!,
      model: env.OPENAI_MODEL,
      messages: promptMessages,
      timeoutMs: env.OPENAI_TIMEOUT_MS,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (
      err.message.includes('abort') || err.message.includes('timeout')
    );
    const incidentType = isTimeout ? 'llm_timeout' : 'llm_api_error';
    const errorMessage = err instanceof Error ? err.message : String(err);

    await logIncidentCommitted({
      environment,
      conversation_id: conversationId,
      agent_turn_id: null,
      incident_type: incidentType,
      severity: 'high',
      details: { job_id: jobId, error: errorMessage, duration_ms: Date.now() - llmStart },
    });

    throw err; // vai marcar job como failed
  }

  logger.debug(
    {
      job_id: jobId,
      duration_ms: llmResult.durationMs,
      input_tokens: llmResult.inputTokens,
      output_tokens: llmResult.outputTokens,
    },
    'organizadora: llm call done',
  );

  // 4. Parsear resposta
  const parsed = parseOrganizadoraResponse(llmResult.content, SCHEMA_VERSION);

  if (!parsed.ok) {
    await logIncidentCommitted({
      environment,
      conversation_id: conversationId,
      agent_turn_id: null,
      incident_type: 'schema_violation',
      severity: 'medium',
      details: { job_id: jobId, error: parsed.error, parse_details: parsed.details },
    });
    // Job marcado como failed — payload inválido não deve ser reprocessado sem intervenção
    throw new Error(`organizadora: llm response invalid — ${parsed.error}`);
  }

  const llmFacts = parsed.data.facts;
  const deterministicFacts = inferDeterministicFacts(messages, llmFacts);
  const facts: FactForWrite[] = [...llmFacts, ...deterministicFacts];
  logger.info(
    { job_id: jobId, fact_count: facts.length, llm_fact_count: llmFacts.length, deterministic_fact_count: deterministicFacts.length },
    'organizadora: facts extracted',
  );

  // 5. Validar e gravar cada fact
  let savedCount = 0;
  let rejectedCount = 0;

  for (const fact of facts) {
    // 5a. Confidence mínima
    if (fact.confidence_level < MIN_CONFIDENCE) {
      logger.debug(
        { fact_key: fact.fact_key, confidence: fact.confidence_level },
        'organizadora: fact below min confidence, skipping',
      );
      rejectedCount++;
      continue;
    }

    // 5b. Validar fact_value contra schema da chave
    const valueResult = validateFactValue(fact.fact_key, fact.fact_value);

    if (!valueResult) {
      // Chave não está na whitelist
      await logIncident(client, {
        environment,
        conversation_id: conversationId,
        agent_turn_id: null,
        incident_type: 'schema_violation',
        severity: 'medium',
        details: {
          job_id: jobId,
          fact_key: fact.fact_key,
          error: 'fact_key not in whitelist',
        },
      });
      rejectedCount++;
      continue;
    }

    if (!valueResult.success) {
      await logIncident(client, {
        environment,
        conversation_id: conversationId,
        agent_turn_id: null,
        incident_type: 'schema_violation',
        severity: 'low',
        details: {
          job_id: jobId,
          fact_key: fact.fact_key,
          fact_value: fact.fact_value,
          issues: valueResult.error.issues,
        },
      });
      rejectedCount++;
      continue;
    }

    // 5c. Gravar fact + evidence — SAVEPOINT por fato para isolar falhas
    //     Se um fato falhar (trigger, constraint), só ele é descartado.
    //     Sem SAVEPOINT, um erro SQL aborta a transação inteira e todos
    //     os fatos seguintes falham com "current transaction is aborted".
    const evidenceResult = validateFactEvidence(fact, messages);
    if (!evidenceResult.ok) {
      await logIncident(client, {
        environment,
        conversation_id: conversationId,
        agent_turn_id: null,
        incident_type: evidenceResult.error === 'evidence_not_literal' ? 'evidence_not_literal' : 'schema_violation',
        severity: 'medium',
        details: {
          job_id: jobId,
          fact_key: fact.fact_key,
          from_message_id: fact.from_message_id,
          evidence_text: fact.evidence_text,
          error: evidenceResult.error,
        },
      });
      rejectedCount++;
      continue;
    }

    const sp = `sp_fact_${savedCount + rejectedCount}`;
    try {
      await client.query(`SAVEPOINT ${sp}`);
      await writeFactWithEvidence(
        client,
        {
          environment,
          conversation_id: conversationId,
          fact_key: fact.fact_key,
          fact_value: valueResult.data,
          observed_at: new Date(),
          message_id: fact.from_message_id,
          truth_type: fact.truth_type,
          source: fact.source ?? EXTRACTOR_SOURCE,
          confidence_level: fact.confidence_level,
          extractor_version: EXTRACTOR_VERSION,
        },
        {
          from_message_id: fact.from_message_id,
          evidence_text: fact.evidence_text,
          evidence_type: fact.evidence_type,
          extractor_version: EXTRACTOR_VERSION,
        },
      );
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      savedCount++;
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
      logger.error({ err, fact_key: fact.fact_key, job_id: jobId }, 'organizadora: failed to write fact, rolled back savepoint');
      rejectedCount++;
    }
  }

  logger.info(
    { job_id: jobId, conversation_id: conversationId, saved: savedCount, rejected: rejectedCount },
    'organizadora: job complete',
  );

  // 6. Marcar job como done
  await markJobDone(client, jobId, lastMessageId);
}

// ------------------------------------------------------------------
// Loop de poll
// ------------------------------------------------------------------

export async function pollAndOrganize(): Promise<void> {
  let client: PoolClient | null = null;

  try {
    client = await pool.connect();

    await client.query('BEGIN');

    const job = await pickEnrichmentJob(client, env.FAREJADOR_ENV);

    if (!job) {
      await client.query('COMMIT');
      return;
    }

    logger.info(
      { job_id: job.id, conversation_id: job.conversation_id },
      'organizadora: picked job',
    );

    await markJobRunning(client, job.id, WORKER_ID);
    await client.query('COMMIT');

    try {
      await client.query('BEGIN');
      await processJob(client, job.environment as Environment, job.id, job.conversation_id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');

      // Abre nova transação só para marcar falha
      await client.query('BEGIN');
      const errorMessage = err instanceof Error ? err.message : String(err);
      await markJobFailed(client, job.id, errorMessage);
      await client.query('COMMIT');
    }
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    logger.error({ err }, 'organizadora: poll failed');
  } finally {
    client?.release();
  }
}

export function startOrganizadora(): () => void {
  if (!env.ORGANIZADORA_ENABLED) {
    logger.info('organizadora: disabled (ORGANIZADORA_ENABLED=false)');
    return () => {};
  }

  if (!env.OPENAI_API_KEY) {
    throw new Error('ORGANIZADORA_ENABLED=true mas OPENAI_API_KEY não está definida');
  }

  logger.info(
    { worker_id: WORKER_ID, model: env.OPENAI_MODEL, poll_interval_ms: env.ORGANIZADORA_POLL_INTERVAL_MS },
    'organizadora: starting',
  );

  let stopped = false;

  async function loop(): Promise<void> {
    if (stopped) return;
    await pollAndOrganize();
    setTimeout(loop, env.ORGANIZADORA_POLL_INTERVAL_MS);
  }

  void loop();

  return function stop(): void {
    stopped = true;
    logger.info({ worker_id: WORKER_ID }, 'organizadora: stopping');
  };
}
