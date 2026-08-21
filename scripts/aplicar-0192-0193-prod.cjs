#!/usr/bin/env node

'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const root = path.resolve(__dirname, '..');
const migrationFiles = [
  '0192_team_employment_and_payroll_integrity.sql',
  '0193_partner_staff_employment_rollovers.sql',
];
const commit = process.argv.includes('--commit');

function assertLocalGuards() {
  if (process.env.ALLOW_PROD_TEAM_MIGRATIONS !== '0192-0193') {
    throw new Error('explicit_migration_authorization_required');
  }
  if (process.env.FAREJADOR_ENV !== 'prod') throw new Error('prod_environment_required');
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  if (!process.env.PROD_BACKUP_FILE) throw new Error('verified_backup_required');
  if (!process.env.PROD_BACKUP_SHA256) throw new Error('backup_hash_required');
  const actual = createHash('sha256')
    .update(readFileSync(process.env.PROD_BACKUP_FILE)).digest('hex').toLowerCase();
  if (actual !== process.env.PROD_BACKUP_SHA256.toLowerCase()) {
    throw new Error('backup_hash_mismatch');
  }
  const manifest = auditMigrationManifest(root);
  if (!manifest.ok) {
    throw new Error(`migration_manifest_invalid:${manifest.errors.join('|')}`);
  }
}

async function objectState(client) {
  const result = await client.query(`SELECT jsonb_build_object(
    'matriz_employment_table',
      to_regclass('network.matriz_collaborator_employment_periods') IS NOT NULL,
    'partner_employment_table',
      to_regclass('network.partner_collaborator_employment_periods') IS NOT NULL,
    'allocation_table',
      to_regclass('finance.matriz_payroll_adjustment_allocations') IS NOT NULL,
    'job_role_column',EXISTS(
      SELECT 1 FROM pg_attribute
       WHERE attrelid='network.partner_access_tokens'::regclass
         AND attname='job_role' AND NOT attisdropped),
    'matriz_employed_on',to_regprocedure(
      'finance.matriz_collaborator_employed_on(env_t,uuid,date)') IS NOT NULL,
    'partner_employed_in_period',to_regprocedure(
      'finance.partner_collaborator_employed_in_period(env_t,uuid,date,date)') IS NOT NULL,
    'allocation_function',to_regprocedure(
      'finance.allocate_matriz_payroll_adjustments(env_t,uuid,uuid,text,numeric)') IS NOT NULL,
    'payroll_competence_trigger',EXISTS(
      SELECT 1 FROM pg_trigger
       WHERE tgrelid='finance.matriz_payroll_periods'::regclass
         AND tgname='matriz_payroll_completed_competence' AND tgenabled<>'D'),
    'partner_salary_rollover',EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n
      ON n.oid=p.pronamespace WHERE n.nspname='finance'
      AND p.proname='run_partner_staff_salary_rollover'
      AND pg_get_functiondef(p.oid) LIKE '%partner_collaborator_employed_in_period%'),
    'partner_payroll_prepare',EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n
      ON n.oid=p.pronamespace WHERE n.nspname='finance'
      AND p.proname='prepare_partner_payroll_period'
      AND pg_get_functiondef(p.oid) LIKE '%partner_collaborator_employed_in_period%'),
    'partner_commission_sync',EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n
      ON n.oid=p.pronamespace WHERE n.nspname='finance'
      AND p.proname='sync_partner_commission_to_payroll'
      AND pg_get_functiondef(p.oid) LIKE '%partner_collaborator_employed_in_period%'),
    'partner_payroll_seed',EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n
      ON n.oid=p.pronamespace WHERE n.nspname='finance'
      AND p.proname='run_partner_staff_payroll_seed'
      AND pg_get_functiondef(p.oid) LIKE '%partner_collaborator_employed_in_period%'),
    'partner_role_no_employment_read',CASE WHEN to_regclass(
      'network.partner_collaborator_employment_periods') IS NULL THEN false
      ELSE NOT has_table_privilege('farejador_partner_app',
        'network.partner_collaborator_employment_periods','SELECT') END,
    'partner_role_no_allocation_read',CASE WHEN to_regclass(
      'finance.matriz_payroll_adjustment_allocations') IS NULL THEN false
      ELSE NOT has_table_privilege('farejador_partner_app',
        'finance.matriz_payroll_adjustment_allocations','SELECT') END
  ) state`);
  return result.rows[0].state;
}

async function sourceCounts(client) {
  const result = await client.query(`SELECT jsonb_build_object(
    'matriz_collaborators',(SELECT count(*) FROM network.matriz_collaborators),
    'partner_staff',(SELECT count(*) FROM network.partner_access_tokens WHERE role='funcionario'),
    'matriz_compensation',(SELECT count(*) FROM network.matriz_collaborator_compensation),
    'matriz_commission_rules',(SELECT count(*) FROM network.matriz_collaborator_commission_rules),
    'partner_compensation',(SELECT count(*) FROM network.partner_collaborator_compensation),
    'payroll_adjustments',(SELECT count(*) FROM finance.matriz_payroll_adjustments),
    'payroll_periods',(SELECT count(*) FROM finance.matriz_payroll_periods),
    'payroll_items',(SELECT count(*) FROM finance.matriz_payroll_items)
  ) counts`);
  return result.rows[0].counts;
}

async function backfillState(client) {
  const result = await client.query(`SELECT jsonb_build_object(
    'matriz_periods',(SELECT count(*) FROM network.matriz_collaborator_employment_periods),
    'matriz_open',(SELECT count(*) FROM network.matriz_collaborator_employment_periods WHERE ended_at IS NULL),
    'matriz_active',(SELECT count(*) FROM network.matriz_collaborators WHERE revoked_at IS NULL),
    'partner_periods',(SELECT count(*) FROM network.partner_collaborator_employment_periods),
    'partner_open',(SELECT count(*) FROM network.partner_collaborator_employment_periods WHERE ended_at IS NULL),
    'partner_active',(SELECT count(*) FROM network.partner_access_tokens WHERE role='funcionario' AND revoked_at IS NULL),
    'staff_without_permissions',(SELECT count(*) FROM network.partner_access_tokens pat
      WHERE pat.role='funcionario' AND NOT EXISTS(
        SELECT 1 FROM network.partner_token_permissions p WHERE p.token_id=pat.id)),
    'invalid_job_roles',(SELECT count(*) FROM network.partner_access_tokens
      WHERE job_role NOT IN ('vendedor','estoque','entregador','colaborador'))
  ) state`);
  return result.rows[0].state;
}

function allTrue(state) {
  return Object.values(state).every((value) => value === true);
}

async function trackerState(client) {
  const result = await client.query(`SELECT max(version) tracker_last,
    count(*)::int tracker_rows FROM supabase_migrations.schema_migrations`);
  return result.rows[0];
}

async function main() {
  assertLocalGuards();
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const beforeCounts = await sourceCounts(client);
  const tracker = await trackerState(client);
  let transactionFinished = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='180s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='240s'`);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0192-0193'))`,
    );
    const before = await objectState(client);
    const installed = Object.values(before).filter((value) => value === true).length;
    if (installed > 2) {
      throw new Error(allTrue(before)
        ? 'migrations_already_applied'
        : `partial_migration_state:${JSON.stringify(before)}`);
    }
    for (const file of migrationFiles) {
      const sql = readFileSync(path.join(root, 'db', 'migrations', file), 'utf8');
      await client.query(sql);
      console.log(`APPLIED_IN_TRANSACTION:${file}`);
    }
    const inside = await objectState(client);
    if (!allTrue(inside)) {
      throw new Error(`migration_verification_failed:${JSON.stringify(inside)}`);
    }
    const backfill = await backfillState(client);
    if (Number(backfill.matriz_open) !== Number(backfill.matriz_active)
      || Number(backfill.partner_open) !== Number(backfill.partner_active)
      || Number(backfill.staff_without_permissions) !== 0
      || Number(backfill.invalid_job_roles) !== 0) {
      throw new Error(`backfill_verification_failed:${JSON.stringify(backfill)}`);
    }
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    transactionFinished = true;

    const afterCounts = await sourceCounts(client);
    if (JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts)) {
      throw new Error('source_counts_changed');
    }
    const outside = await objectState(client);
    if (commit && !allTrue(outside)) throw new Error('post_commit_objects_missing');
    if (!commit && Object.values(outside).filter((value) => value === true).length > installed) {
      throw new Error('dry_run_left_schema_changes');
    }
    const finalBackfill = commit ? await backfillState(client) : null;
    console.log(JSON.stringify({
      environment: 'prod', mode: commit ? 'commit' : 'dry-run',
      migrations: migrationFiles, objects: commit ? outside : inside,
      source_counts_preserved: true, backfill: finalBackfill,
      migration_tracker: { ...tracker, action: 'preserved_without_fabricating_missing_history' },
    }, null, 2));
  } catch (error) {
    if (!transactionFinished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`PROD_TEAM_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
