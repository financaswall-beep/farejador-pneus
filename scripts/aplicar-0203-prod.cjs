#!/usr/bin/env node
'use strict';

const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const root = path.resolve(__dirname, '..');
const migrationFile = '0203_partner_modern_panel_canary.sql';
const commit = process.argv.includes('--commit');
const verifyOnly = process.argv.includes('--verify');

function assertGuards() {
  if (process.env.ALLOW_PROD_PANEL_CANARY_MIGRATION !== '0203') {
    throw new Error('explicit_authorization_required');
  }
  if (process.env.FAREJADOR_ENV !== 'prod') throw new Error('prod_environment_required');
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  const target = new URL(process.env.DATABASE_URL);
  if (!target.hostname.includes('sa-east-1.pooler.supabase.com')) {
    throw new Error(`unexpected_database_region:${target.hostname}`);
  }
  const manifest = auditMigrationManifest(root);
  if (!manifest.ok) throw new Error(`migration_manifest_invalid:${manifest.errors.join('|')}`);
}

function migrationSql() {
  const sql = readFileSync(path.join(root, 'db', 'migrations', migrationFile), 'utf8');
  if (/(^|\n)\s*(BEGIN|COMMIT|ROLLBACK);\s*($|\n)/i.test(sql)) {
    throw new Error('migration_must_be_wrapped_only_by_executor');
  }
  return sql;
}

async function installationState(client) {
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'partner_units',(SELECT count(*)::int FROM network.partner_units),
    'catalog_prerequisite',to_regclass('commerce.tire_specs') IS NOT NULL,
    'fitment_prerequisite',to_regclass('commerce.fitment_discovery_promotions') IS NOT NULL,
    'flag_column',EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='network' AND table_name='partner_units'
        AND column_name='modern_panel_enabled'),
    'flag_not_null',EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='network' AND table_name='partner_units'
        AND column_name='modern_panel_enabled' AND is_nullable='NO'),
    'flag_default_false',EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='network' AND table_name='partner_units'
        AND column_name='modern_panel_enabled' AND column_default ILIKE '%false%'),
    'event_table',to_regclass('ops.partner_panel_canary_events') IS NOT NULL,
    'rls_enabled',EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='ops' AND c.relname='partner_panel_canary_events' AND c.relrowsecurity),
    'insert_policy',(SELECT count(*)::int FROM pg_policies
      WHERE schemaname='ops' AND tablename='partner_panel_canary_events'
        AND policyname='partner_panel_canary_insert_isolation' AND cmd='INSERT'),
    'technical_indexes',(SELECT count(*)::int FROM pg_indexes
      WHERE schemaname='ops' AND tablename='partner_panel_canary_events'
        AND indexname IN ('partner_panel_canary_unit_time_idx','partner_panel_canary_errors_idx')),
    'partner_insert_grant',(SELECT count(*)::int FROM information_schema.table_privileges
      WHERE table_schema='ops' AND table_name='partner_panel_canary_events'
        AND grantee='farejador_partner_app' AND privilege_type='INSERT'),
    'partner_select_grant',(SELECT count(*)::int FROM information_schema.table_privileges
      WHERE table_schema='ops' AND table_name='partner_panel_canary_events'
        AND grantee='farejador_partner_app' AND privilege_type='SELECT'),
    'public_grants',(SELECT count(*)::int FROM information_schema.table_privileges
      WHERE table_schema='ops' AND table_name='partner_panel_canary_events'
        AND grantee='PUBLIC'),
    'forbidden_columns',(SELECT count(*)::int FROM information_schema.columns
      WHERE table_schema='ops' AND table_name='partner_panel_canary_events'
        AND column_name IN ('customer_id','order_id','phone','amount','payload'))
  ) state`);
  const state = rows[0].state;
  state.flag_true_rows = state.flag_column
    ? Number((await client.query(
      `SELECT count(*)::int count FROM network.partner_units WHERE modern_panel_enabled`,
    )).rows[0]?.count ?? 0)
    : 0;
  return state;
}

function installed(state) {
  return state.catalog_prerequisite === true
    && state.fitment_prerequisite === true
    && state.flag_column === true
    && state.flag_not_null === true
    && state.flag_default_false === true
    && Number(state.flag_true_rows) === 0
    && state.event_table === true
    && state.rls_enabled === true
    && Number(state.insert_policy) === 1
    && Number(state.technical_indexes) === 2
    && Number(state.partner_insert_grant) === 1
    && Number(state.partner_select_grant) === 0
    && Number(state.public_grants) === 0
    && Number(state.forbidden_columns) === 0;
}

function pristine(state) {
  return state.catalog_prerequisite === true
    && state.fitment_prerequisite === true
    && state.flag_column === false
    && state.event_table === false
    && Number(state.insert_policy) === 0
    && Number(state.technical_indexes) === 0
    && Number(state.partner_insert_grant) === 0
    && Number(state.partner_select_grant) === 0
    && Number(state.public_grants) === 0
    && Number(state.forbidden_columns) === 0;
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
    if (verifyOnly) {
      if (!installed(before)) {
        throw new Error(`migration_not_verified:${JSON.stringify(before)}`);
      }
      console.log(JSON.stringify({
        environment: 'prod', region: 'sa-east-1', mode: 'verify',
        migration: migrationFile, verified_state: before,
      }, null, 2));
      return;
    }
    if (installed(before)) throw new Error('migration_already_applied');
    if (!pristine(before)) throw new Error(`unexpected_prestate:${JSON.stringify(before)}`);
    if (Number(before.partner_units) !== 0) {
      throw new Error(`non_empty_partner_database:${before.partner_units}`);
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='180s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='240s'`);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0203'))`);
    await client.query(migrationSql());

    const inside = await installationState(client);
    if (!installed(inside)) {
      throw new Error(`object_verification_failed:${JSON.stringify(inside)}`);
    }

    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    transactionFinished = true;
    const outside = await installationState(client);
    if (commit && !installed(outside)) throw new Error('post_commit_objects_missing');
    if (!commit && !pristine(outside)) throw new Error('dry_run_left_schema_changes');

    console.log(JSON.stringify({
      environment: 'prod',
      region: 'sa-east-1',
      mode: commit ? 'commit' : 'dry-run',
      migration: migrationFile,
      before,
      verified_state: commit ? outside : inside,
    }, null, 2));
  } catch (error) {
    if (!transactionFinished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`PROD_PANEL_CANARY_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
