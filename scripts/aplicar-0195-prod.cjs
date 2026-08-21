#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const root = path.resolve(__dirname, '..');
const migrationFile = '0195_network_municipality_catalog.sql';
const commit = process.argv.includes('--commit');

function assertGuards() {
  if (process.env.ALLOW_PROD_MUNICIPALITY_MIGRATION !== '0195') {
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

async function installationState(client) {
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'catalog_table',to_regclass('network.municipality_catalog') IS NOT NULL,
    'guard_function',EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='network' AND p.proname='guard_supported_municipality'
         AND p.prosecdef
         AND p.proconfig @> ARRAY['search_path=pg_catalog, network']::text[]
    ),
    'guard_trigger',EXISTS(
      SELECT 1 FROM pg_trigger
       WHERE tgrelid='network.unit_coverage'::regclass
         AND tgname='unit_coverage_supported_municipality'
         AND tgenabled<>'D'
    ),
    'public_table_access',EXISTS(
      SELECT 1 FROM information_schema.table_privileges
       WHERE grantee='PUBLIC' AND table_schema='network'
         AND table_name='municipality_catalog'
    ),
    'public_function_execute',EXISTS(
      SELECT 1 FROM information_schema.routine_privileges
       WHERE grantee='PUBLIC' AND specific_schema='network'
         AND routine_name='guard_supported_municipality'
         AND privilege_type='EXECUTE'
    )
  ) state`);
  const state = rows[0].state;
  state.catalog_count = state.catalog_table
    ? Number((await client.query(
      'SELECT count(*)::int AS total FROM network.municipality_catalog WHERE active',
    )).rows[0].total)
    : 0;
  return state;
}

async function reconciliation(client) {
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'invalid_prod_coverage',(SELECT count(*)
      FROM network.unit_coverage coverage
      LEFT JOIN network.municipality_catalog catalog
        ON catalog.municipality_key=coverage.municipio AND catalog.active
     WHERE coverage.environment='prod' AND catalog.municipality_key IS NULL),
    'duplicate_catalog_keys',(SELECT count(*) FROM (
      SELECT municipality_key FROM network.municipality_catalog
       GROUP BY municipality_key HAVING count(*)>1
    ) duplicates),
    'non_rj_rows',(SELECT count(*) FROM network.municipality_catalog WHERE state_code<>'RJ'),
    'inactive_rows',(SELECT count(*) FROM network.municipality_catalog WHERE NOT active)
  ) state`);
  return rows[0].state;
}

function installationOk(state) {
  return state.catalog_table === true
    && Number(state.catalog_count) === 92
    && state.guard_function === true
    && state.guard_trigger === true
    && state.public_table_access === false
    && state.public_function_execute === false;
}

const allZero = (state) => Object.values(state).every((value) => Number(value) === 0);

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
    if (before.catalog_table || before.guard_trigger || before.guard_function) {
      throw new Error(installationOk(before)
        ? 'migration_already_applied'
        : `partial_migration_state:${JSON.stringify(before)}`);
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='180s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='240s'`);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0195'))`);
    await client.query(readFileSync(path.join(root, 'db', 'migrations', migrationFile), 'utf8'));

    const inside = await installationState(client);
    const insideReconciliation = await reconciliation(client);
    if (!installationOk(inside)) {
      throw new Error(`object_verification_failed:${JSON.stringify(inside)}`);
    }
    if (!allZero(insideReconciliation)) {
      throw new Error(`reconciliation_failed:${JSON.stringify(insideReconciliation)}`);
    }

    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    transactionFinished = true;

    const outside = await installationState(client);
    if (commit && !installationOk(outside)) throw new Error('post_commit_objects_missing');
    if (!commit && (outside.catalog_table || outside.guard_trigger || outside.guard_function)) {
      throw new Error('dry_run_left_schema_changes');
    }
    const outsideReconciliation = commit ? await reconciliation(client) : null;
    if (commit && !allZero(outsideReconciliation)) {
      throw new Error('post_commit_reconciliation_failed');
    }
    console.log(JSON.stringify({
      environment: 'prod', mode: commit ? 'commit' : 'dry-run', migration: migrationFile,
      objects: commit ? outside : inside,
      reconciliation: commit ? outsideReconciliation : insideReconciliation,
    }, null, 2));
  } catch (error) {
    if (!transactionFinished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`PROD_MUNICIPALITY_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
