import type { PoolClient } from 'pg';
import type { Environment } from '../types/chatwoot.js';

export interface AtendenteEventInput {
  environment: Environment;
  jobId: string;
  actor?: string;
  reason?: string | null;
  attempt?: number | null;
  fromStatus?: string | null;
  toStatus: string;
  errorCode?: string | null;
  errorKind?: string | null;
  errorSummary?: string | null;
}

export async function recordAtendenteJobEvent(
  client: PoolClient,
  input: AtendenteEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO ops.atendente_job_events (
       environment, job_id, actor, reason, attempt, from_status, to_status,
       error_code, error_kind, error_summary
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [input.environment, input.jobId, input.actor ?? 'system', input.reason ?? null,
      input.attempt ?? null, input.fromStatus ?? null, input.toStatus,
      input.errorCode ?? null, input.errorKind ?? null, input.errorSummary ?? null],
  );
}

export async function openJobDeadLetter(
  client: PoolClient,
  input: AtendenteEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO ops.atendente_dead_letters (
       environment, job_id, conversation_id, actor, reason,
       error_code, error_kind, error_summary
     )
     SELECT j.environment, j.id, j.conversation_id, $3, $4, $5, $6, $7
       FROM ops.atendente_jobs j
      WHERE j.id = $2 AND j.environment = $1
     ON CONFLICT (environment, job_id) WHERE job_id IS NOT NULL AND resolved_at IS NULL
     DO UPDATE SET reason = EXCLUDED.reason,
                   error_code = EXCLUDED.error_code,
                   error_kind = EXCLUDED.error_kind,
                   error_summary = EXCLUDED.error_summary`,
    [input.environment, input.jobId, input.actor ?? 'system', input.reason ?? 'job_failed',
      input.errorCode ?? null, input.errorKind ?? null, input.errorSummary ?? null],
  );
}
