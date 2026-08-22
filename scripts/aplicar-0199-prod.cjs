#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const root = path.resolve(__dirname, '..');
const migrationFile = '0199_system_continuity.sql';
const commit = process.argv.includes('--commit');

function assertGuards() {
  if (process.env.ALLOW_PROD_CONTINUITY_MIGRATION !== '0199') {
    throw new Error('explicit_authorization_required');
  }
  if (process.env.FAREJADOR_ENV !== 'prod') throw new Error('prod_environment_required');
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  if (!process.env.PROD_BACKUP_FILE || !process.env.PROD_BACKUP_SHA256) {
    throw new Error('verified_backup_required');
  }
  const actual = createHash('sha256')
    .update(readFileSync(process.env.PROD_BACKUP_FILE)).digest('hex');
  if (actual.toLowerCase() !== process.env.PROD_BACKUP_SHA256.toLowerCase()) {
    throw new Error('backup_hash_mismatch');
  }
  const manifest = auditMigrationManifest(root);
  if (!manifest.ok) throw new Error(`migration_manifest_invalid:${manifest.errors.join('|')}`);
}

function migrationSql() {
  const raw = readFileSync(path.join(root, 'db', 'migrations', migrationFile), 'utf8');
  const withoutBegin = raw.replace(/^(?:\uFEFF)?([\s\S]*?\n)BEGIN;\s*/m, '$1');
  const withoutCommit = withoutBegin.replace(/\s*COMMIT;\s*$/, '\n');
  if (withoutCommit === raw || /(^|\n)\s*(BEGIN|COMMIT);\s*($|\n)/i.test(withoutCommit)) {
    throw new Error('migration_transaction_wrapper_not_removed');
  }
  return withoutCommit;
}

async function installationState(client) {
  const markerExists = (await client.query(
    `SELECT to_regclass('ops.application_schema_state') IS NOT NULL present`,
  )).rows[0].present;
  const marker = markerExists
    ? (await client.query(
      `SELECT version,migration_name FROM ops.application_schema_state WHERE singleton=true`,
    )).rows[0] ?? null
    : null;
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'constraints',(SELECT count(*)::int FROM pg_constraint
      WHERE conname IN (
        'order_items_discount_within_line_check',
        'wholesale_orders_payment_dates_check',
        'commission_entries_partner_order_fk'
      ) AND convalidated),
    'indexes',(SELECT count(*)::int FROM pg_indexes WHERE indexname IN (
      'partner_sessions_retention_idx','matriz_staff_sessions_retention_idx',
      'meta_sync_runs_retention_idx','atendente_dead_letters_retention_idx'
    )),
    'retention_function',(SELECT count(*)::int FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='ops' AND p.proname='perform_operational_retention'),
    'retention_job',(SELECT count(*)::int FROM cron.job
      WHERE jobname='farejador-operational-retention' AND active),
    'partition_job',(SELECT count(*)::int FROM cron.job
      WHERE jobname='farejador-ensure-partitions' AND active),
    'sp_defaults',(SELECT count(*)::int FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      WHERE d.adrelid IN (
        'network.matriz_collaborator_compensation'::regclass,
        'network.matriz_collaborator_commission_rules'::regclass
      ) AND a.attname='starts_on'
        AND pg_get_expr(d.adbin,d.adrelid) LIKE '%America/Sao_Paulo%'),
    'public_table_privileges',(SELECT count(*)::int FROM information_schema.table_privileges
      WHERE table_schema='ops' AND table_name='application_schema_state'
        AND grantee='PUBLIC'),
    'public_function_execute',(SELECT count(*)::int
      FROM information_schema.routine_privileges
      WHERE specific_schema='ops' AND routine_name='perform_operational_retention'
        AND grantee='PUBLIC' AND privilege_type='EXECUTE'),
    'missing_partitions',(WITH months AS (
      SELECT to_char(date_trunc('month',now())+(n||' months')::interval,'YYYY_MM') suffix
        FROM generate_series(0,6) n
    ) SELECT count(*)::int FROM months
      WHERE to_regclass('raw.raw_events_'||suffix) IS NULL
         OR to_regclass('core.messages_'||suffix) IS NULL)
  ) state`);
  return { marker_exists: markerExists, marker, ...rows[0].state };
}

function installationOk(state) {
  return state.marker_exists
    && Number(state.marker?.version) === 199
    && state.marker?.migration_name === migrationFile
    && Number(state.constraints) === 3
    && Number(state.indexes) === 4
    && Number(state.retention_function) === 1
    && Number(state.retention_job) === 1
    && Number(state.partition_job) === 1
    && Number(state.sp_defaults) === 2
    && Number(state.public_table_privileges) === 0
    && Number(state.public_function_execute) === 0
    && Number(state.missing_partitions) === 0;
}

function anyNewInstalled(state) {
  return state.marker_exists
    || Number(state.constraints) > 0
    || Number(state.indexes) > 0
    || Number(state.retention_function) > 0
    || Number(state.retention_job) > 0
    || Number(state.sp_defaults) > 0;
}

async function probeRetention(client) {
  await client.query('SAVEPOINT continuity_retention_probe');
  const result = await client.query(
    `SELECT ops.perform_operational_retention('1900-01-01T00:00:00Z'::timestamptz) result`,
  );
  await client.query('ROLLBACK TO SAVEPOINT continuity_retention_probe');
  const expected = [
    'partner_sessions','matriz_staff_sessions','cron_job_runs',
    'meta_sync_runs','resolved_dead_letters',
  ];
  if (!expected.every((key) => Number(result.rows[0]?.result?.[key]) === 0)) {
    throw new Error(`retention_probe_failed:${JSON.stringify(result.rows[0]?.result)}`);
  }
}

async function main() {
  assertGuards();
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  let transactionFinished = false;
  try {
    const before = await installationState(client);
    if (installationOk(before)) throw new Error('migration_already_applied');
    if (anyNewInstalled(before)) {
      throw new Error(`partial_migration_state:${JSON.stringify(before)}`);
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='180s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='240s'`);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0199'))`);
    await client.query(migrationSql());

    const inside = await installationState(client);
    if (!installationOk(inside)) {
      throw new Error(`object_verification_failed:${JSON.stringify(inside)}`);
    }
    await probeRetention(client);

    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    transactionFinished = true;
    const outside = await installationState(client);
    if (commit && !installationOk(outside)) throw new Error('post_commit_objects_missing');
    if (!commit && anyNewInstalled(outside)) throw new Error('dry_run_left_schema_changes');

    console.log(JSON.stringify({
      environment: 'prod', mode: commit ? 'commit' : 'dry-run', migration: migrationFile,
      state: commit ? outside : inside,
    }, null, 2));
  } catch (error) {
    if (!transactionFinished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`PROD_CONTINUITY_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
