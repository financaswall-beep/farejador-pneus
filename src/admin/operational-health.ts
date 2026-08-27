import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

type ContinuityRow = {
  schema_version: number | string | null;
  schema_migration_name: string | null;
  migration_ledger_rows: number | string;
  migration_ledger_version: number | string | null;
  migration_ledger_latest: string | null;
  missing_partitions: number | string;
  partition_job_active: boolean;
  retention_job_active: boolean;
  partition_last_success: string | null;
  retention_last_success: string | null;
  latest_raw_event: string | null;
  stale_raw_pending: number | string;
  recent_raw_failed: number | string;
  open_dead_letters: number | string;
  stuck_jobs: number | string;
  stuck_outbound: number | string;
  stale_meta_runs: number | string;
  latest_meta_success: string | null;
  cron_history_bytes: number | string;
};

export type OperationalContinuity = {
  critical: string[];
  warnings: string[];
  details: {
    schema_version: number;
    schema_migration_name: string | null;
    migration_ledger_rows: number;
    migration_ledger_version: number;
    migration_ledger_latest: string | null;
    missing_partitions: number;
    latest_raw_event: string | null;
    latest_meta_success: string | null;
    open_dead_letters: number;
    cron_history_bytes: number;
  };
};

const CONTINUITY_SQL = `
  WITH months AS (
    SELECT to_char(date_trunc('month',now())+(n||' months')::interval,'YYYY_MM') suffix
      FROM generate_series(0,2) n
  ), partitions AS (
    SELECT count(*) FILTER (WHERE to_regclass('raw.raw_events_'||suffix) IS NULL)
         + count(*) FILTER (WHERE to_regclass('core.messages_'||suffix) IS NULL)
           AS missing_partitions
      FROM months
  ), cron_state AS (
    SELECT
      COALESCE(bool_or(jobname='farejador-ensure-partitions' AND active),false)
        AS partition_job_active,
      COALESCE(bool_or(jobname='farejador-operational-retention' AND active),false)
        AS retention_job_active
      FROM cron.job
  )
  SELECT
    (SELECT version FROM ops.application_schema_state WHERE singleton=true) schema_version,
    (SELECT migration_name FROM ops.application_schema_state WHERE singleton=true)
      schema_migration_name,
    (SELECT count(*) FROM ops.applied_migrations) migration_ledger_rows,
    (SELECT max(migration_order) FROM ops.applied_migrations) migration_ledger_version,
    (SELECT migration_file FROM ops.applied_migrations
      ORDER BY migration_order DESC,migration_suffix DESC LIMIT 1) migration_ledger_latest,
    (SELECT missing_partitions FROM partitions) missing_partitions,
    (SELECT partition_job_active FROM cron_state) partition_job_active,
    (SELECT retention_job_active FROM cron_state) retention_job_active,
    (SELECT max(d.end_time)::text FROM cron.job_run_details d JOIN cron.job j USING(jobid)
      WHERE j.jobname='farejador-ensure-partitions' AND d.status='succeeded') partition_last_success,
    (SELECT max(d.end_time)::text FROM cron.job_run_details d JOIN cron.job j USING(jobid)
      WHERE j.jobname='farejador-operational-retention' AND d.status='succeeded') retention_last_success,
    (SELECT max(received_at)::text FROM raw.raw_events WHERE environment=$1) latest_raw_event,
    (SELECT count(*) FROM raw.raw_events WHERE environment=$1
      AND processing_status='pending' AND received_at<now()-interval '15 minutes') stale_raw_pending,
    (SELECT count(*) FROM raw.raw_events WHERE environment=$1
      AND processing_status='failed' AND received_at>=now()-interval '24 hours') recent_raw_failed,
    (SELECT count(*) FROM ops.atendente_dead_letters WHERE environment=$1 AND resolved_at IS NULL)
      open_dead_letters,
    (SELECT count(*) FROM ops.atendente_jobs WHERE environment=$1
      AND status='processing' AND locked_at<now()-interval '15 minutes') stuck_jobs,
    (SELECT count(*) FROM ops.outbound_messages WHERE environment=$1
      AND status='sending' AND locked_at<now()-interval '15 minutes') stuck_outbound,
    (SELECT count(*) FROM marketing.meta_sync_runs WHERE environment=$1
      AND status='running' AND started_at<now()-interval '1 hour') stale_meta_runs,
    (SELECT max(finished_at)::text FROM marketing.meta_sync_runs WHERE environment=$1
      AND status='succeeded') latest_meta_success,
    CASE WHEN to_regclass('cron.job_run_details') IS NULL THEN 0
      ELSE pg_total_relation_size('cron.job_run_details') END cron_history_bytes`;

function count(value: number | string | null | undefined): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function olderThan(value: string | null, milliseconds: number, now: Date): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && now.getTime()-timestamp > milliseconds;
}

export async function inspectOperationalContinuity(
  db: Queryable,
  environment: string,
  now = new Date(),
): Promise<OperationalContinuity> {
  const result = await db.query<ContinuityRow>(CONTINUITY_SQL, [environment]);
  const row = result.rows[0];
  if (!row) throw new Error('operational_continuity_unavailable');
  const critical: string[] = [];
  const warnings: string[] = [];
  const schemaVersion = count(row.schema_version);
  const ledgerRows = count(row.migration_ledger_rows);
  const ledgerVersion = count(row.migration_ledger_version);
  const missingPartitions = count(row.missing_partitions);

  if (schemaVersion < 213) critical.push('schema_marker_outdated');
  if (ledgerRows < 214) critical.push('migration_ledger_incomplete');
  if (ledgerVersion !== schemaVersion
      || row.migration_ledger_latest !== row.schema_migration_name) {
    critical.push('migration_ledger_state_mismatch');
  }
  if (missingPartitions > 0) critical.push('future_partitions_missing');
  if (!row.partition_job_active) critical.push('partition_job_inactive');
  if (!row.retention_job_active) warnings.push('retention_job_inactive');
  if (!row.partition_last_success) warnings.push('partition_job_not_observed');
  if (!row.retention_last_success) warnings.push('retention_job_not_observed');
  else if (olderThan(row.retention_last_success, 48*60*60_000, now)) {
    warnings.push('retention_job_stale');
  }
  if (!row.latest_raw_event || olderThan(row.latest_raw_event, 24*60*60_000, now)) {
    warnings.push('chatwoot_ingestion_stale');
  }
  if (count(row.stale_raw_pending)>0) warnings.push('raw_events_pending_stale');
  if (count(row.recent_raw_failed)>0) warnings.push('raw_events_failed_recently');
  if (count(row.open_dead_letters)>0) warnings.push('dead_letters_open');
  if (count(row.stuck_jobs)>0) warnings.push('atendente_jobs_stuck');
  if (count(row.stuck_outbound)>0) warnings.push('outbound_messages_stuck');
  if (count(row.stale_meta_runs)>0) warnings.push('meta_sync_stuck');
  if (count(row.cron_history_bytes)>100*1024*1024) warnings.push('cron_history_large');

  return {
    critical,
    warnings,
    details: {
      schema_version: schemaVersion,
      schema_migration_name: row.schema_migration_name,
      migration_ledger_rows: ledgerRows,
      migration_ledger_version: ledgerVersion,
      migration_ledger_latest: row.migration_ledger_latest,
      missing_partitions: missingPartitions,
      latest_raw_event: row.latest_raw_event,
      latest_meta_success: row.latest_meta_success,
      open_dead_letters: count(row.open_dead_letters),
      cron_history_bytes: count(row.cron_history_bytes),
    },
  };
}
