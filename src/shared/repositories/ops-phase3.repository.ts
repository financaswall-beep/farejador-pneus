/**
 * Repository para ops.* — Fase 3.
 * Cobre: enrichment_jobs (pickup/mark), agent_incidents (log).
 */

import type { PoolClient } from 'pg';
import type { Environment } from '../types/chatwoot.js';
import type { IncidentType, IncidentSeverity } from '../types/ops-phase3.js';

// ------------------------------------------------------------------
// ops.enrichment_jobs
// ------------------------------------------------------------------

export interface EnrichmentJobRow {
  id: string;
  environment: string;
  conversation_id: string;
  last_message_id: string | null;
  job_type: string;
}

/**
 * Pega 1 job da Organizadora pronto para processar.
 * Usa FOR UPDATE SKIP LOCKED — seguro para múltiplos workers.
 */
export async function pickEnrichmentJob(
  client: PoolClient,
  environment: Environment,
  staleJobAfterSeconds: number,
): Promise<EnrichmentJobRow | null> {
  const result = await client.query<EnrichmentJobRow>(
    `SELECT id, environment, conversation_id, last_message_id, job_type
     FROM ops.enrichment_jobs
     WHERE environment = $1
       AND not_before <= now()
       AND job_type = 'organize_conversation'
       AND (
         status IN ('pending', 'queued')
         OR (
           status = 'running'
           AND locked_at IS NOT NULL
           AND locked_at < now() - ($2::int * interval '1 second')
         )
       )
     ORDER BY not_before
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [environment, staleJobAfterSeconds],
  );
  return result.rows[0] ?? null;
}

export async function markJobRunning(
  client: PoolClient,
  jobId: string,
  workerId: string,
): Promise<void> {
  await client.query(
    `UPDATE ops.enrichment_jobs
     SET status     = 'running',
         started_at = now(),
         locked_at  = now(),
         locked_by  = $2,
         attempts   = attempts + 1
     WHERE id = $1`,
    [jobId, workerId],
  );
}

export async function markJobDone(
  client: PoolClient,
  jobId: string,
  lastProcessedMessageId: string | null,
): Promise<void> {
  await client.query(
    `UPDATE ops.enrichment_jobs
     SET status                      = 'done',
         completed_at                = now(),
         locked_at                   = NULL,
         locked_by                   = NULL,
         last_processed_message_id   = $2
     WHERE id = $1`,
    [jobId, lastProcessedMessageId],
  );
}

export async function markJobFailed(
  client: PoolClient,
  jobId: string,
  errorMessage: string,
): Promise<void> {
  await client.query(
    `UPDATE ops.enrichment_jobs
     SET status       = 'failed',
         completed_at = now(),
         locked_at    = NULL,
         locked_by    = NULL,
         last_error   = $2
     WHERE id = $1`,
    [jobId, errorMessage.slice(0, 1000)],
  );
}

// ------------------------------------------------------------------
// ops.agent_incidents
// ------------------------------------------------------------------

export interface IncidentInsert {
  environment: Environment;
  conversation_id: string | null;
  agent_turn_id: string | null;
  incident_type: IncidentType;
  severity: IncidentSeverity;
  details: Record<string, unknown>;
}

export async function logIncident(
  client: PoolClient,
  incident: IncidentInsert,
): Promise<void> {
  await client.query(
    `INSERT INTO ops.agent_incidents
       (environment, conversation_id, agent_turn_id, incident_type, severity, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      incident.environment,
      incident.conversation_id,
      incident.agent_turn_id,
      incident.incident_type,
      incident.severity,
      JSON.stringify(incident.details),
    ],
  );
}
