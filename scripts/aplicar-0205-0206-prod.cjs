#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const root = path.resolve(__dirname, '..');
const migrations = [
  '0205_partner_stock_panel_canary.sql',
  '0206_partner_panel_catalog_read_grants.sql',
];
const expectedProjectUser = 'postgres.beisgivepyfhgcujsqan';
const commit = process.argv.includes('--commit');
const verifyOnly = process.argv.includes('--verify');

function assertBackup() {
  if (!commit) return;
  const backupPath = process.env.PROD_BACKUP_PATH;
  const expectedHash = process.env.PROD_BACKUP_SHA256;
  if (!backupPath || !/^[a-f0-9]{64}$/i.test(expectedHash ?? '')) {
    throw new Error('verified_backup_required');
  }

  const resolved = path.resolve(backupPath);
  const backupRoot = path.join(root, '.codex-tmp', 'backups');
  const relative = path.relative(backupRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('backup_must_be_inside_codex_tmp_backups');
  }
  if (statSync(resolved).size <= 0) throw new Error('backup_is_empty');
  const actualHash = createHash('sha256').update(readFileSync(resolved)).digest('hex');
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error('backup_hash_mismatch');
  }
}

function assertGuards() {
  if (process.env.ALLOW_PROD_PARTNER_SUITE_MIGRATION !== '0205-0206') {
    throw new Error('explicit_authorization_required');
  }
  if (process.env.FAREJADOR_ENV !== 'prod') throw new Error('prod_environment_required');
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  const target = new URL(process.env.DATABASE_URL);
  if (!target.hostname.includes('sa-east-1.pooler.supabase.com')) {
    throw new Error(`unexpected_database_region:${target.hostname}`);
  }
  if (decodeURIComponent(target.username) !== expectedProjectUser) {
    throw new Error('unexpected_supabase_project');
  }
  const manifest = auditMigrationManifest(root);
  if (!manifest.ok) throw new Error(`migration_manifest_invalid:${manifest.errors.join('|')}`);
  assertBackup();
}

function migrationSql(file) {
  const sql = readFileSync(path.join(root, 'db', 'migrations', file), 'utf8');
  if (/(^|\n)\s*(BEGIN|COMMIT|ROLLBACK);\s*($|\n)/i.test(sql)) {
    throw new Error(`migration_must_be_wrapped_only_by_executor:${file}`);
  }
  return sql;
}

async function installationState(client) {
  const { rows } = await client.query(`
    SELECT jsonb_build_object(
      'role_exists', EXISTS(SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app'),
      'canary_table', to_regclass('ops.partner_panel_canary_events') IS NOT NULL,
      'vehicle_models_table', to_regclass('commerce.vehicle_models') IS NOT NULL,
      'vehicle_fitments_table', to_regclass('commerce.vehicle_fitments') IS NOT NULL,
      'page_constraint', COALESCE((
        SELECT pg_get_constraintdef(oid)
          FROM pg_constraint
         WHERE conrelid=to_regclass('ops.partner_panel_canary_events')
           AND conname='partner_panel_canary_events_page_check'
      ), ''),
      'operation_constraint', COALESCE((
        SELECT pg_get_constraintdef(oid)
          FROM pg_constraint
         WHERE conrelid=to_regclass('ops.partner_panel_canary_events')
           AND conname='partner_panel_canary_events_operation_check'
      ), ''),
      'catalog_select_grants', (
        SELECT count(*)::int
          FROM information_schema.table_privileges
         WHERE table_schema='commerce'
           AND table_name IN ('vehicle_models','vehicle_fitments')
           AND grantee='farejador_partner_app'
           AND privilege_type='SELECT'
      ),
      'catalog_forbidden_grants', (
        SELECT count(*)::int
          FROM information_schema.table_privileges
         WHERE table_schema='commerce'
           AND table_name IN ('vehicle_models','vehicle_fitments')
           AND grantee='farejador_partner_app'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
      )
    ) state
  `);
  return rows[0].state;
}

function prerequisites(state) {
  return state.role_exists === true
    && state.canary_table === true
    && state.vehicle_models_table === true
    && state.vehicle_fitments_table === true
    && String(state.page_constraint).includes("'resumo'::text")
    && String(state.page_constraint).includes("'retiradas'::text")
    && String(state.operation_constraint).includes("'load_summary'::text")
    && String(state.operation_constraint).includes("'load_pickups'::text");
}

function installed(state) {
  return prerequisites(state)
    && String(state.page_constraint).includes("'estoque'::text")
    && String(state.operation_constraint).includes("'load_stock'::text")
    && String(state.operation_constraint).includes("'load_stock_detail'::text")
    && String(state.operation_constraint).includes("'request_stock_count'::text")
    && Number(state.catalog_select_grants) === 2
    && Number(state.catalog_forbidden_grants) === 0;
}

function pristine(state) {
  return prerequisites(state)
    && !String(state.page_constraint).includes("'estoque'::text")
    && !String(state.operation_constraint).includes("'load_stock'::text")
    && !String(state.operation_constraint).includes("'load_stock_detail'::text")
    && !String(state.operation_constraint).includes("'request_stock_count'::text")
    && Number(state.catalog_select_grants) === 0
    && Number(state.catalog_forbidden_grants) === 0;
}

async function main() {
  assertGuards();
  const target = new URL(process.env.DATABASE_URL);
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  let transactionFinished = false;
  try {
    const before = await installationState(client);
    if (verifyOnly) {
      if (!installed(before)) throw new Error(`migrations_not_verified:${JSON.stringify(before)}`);
      console.log(JSON.stringify({
        environment: 'prod',
        region: 'sa-east-1',
        database: target.pathname.slice(1),
        mode: 'verify',
        migrations,
        verified_state: before,
      }, null, 2));
      return;
    }
    if (installed(before)) throw new Error('migrations_already_applied');
    if (!pristine(before)) throw new Error(`unexpected_prestate:${JSON.stringify(before)}`);

    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='180s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='240s'`);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0205-0206'))`);
    for (const file of migrations) await client.query(migrationSql(file));

    const inside = await installationState(client);
    if (!installed(inside)) throw new Error(`object_verification_failed:${JSON.stringify(inside)}`);

    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    transactionFinished = true;
    const outside = await installationState(client);
    if (commit && !installed(outside)) throw new Error('post_commit_objects_missing');
    if (!commit && !pristine(outside)) throw new Error('dry_run_left_schema_changes');

    console.log(JSON.stringify({
      environment: 'prod',
      region: 'sa-east-1',
      database: target.pathname.slice(1),
      mode: commit ? 'commit' : 'dry-run',
      migrations,
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
  console.error(`PROD_PARTNER_SUITE_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
