#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const root = path.resolve(__dirname, '..');
const migrationFile = '0196_customer_lead_board.sql';
const commit = process.argv.includes('--commit');

function assertGuards() {
  if (process.env.ALLOW_PROD_CUSTOMER_MIGRATION !== '0196') {
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
    'board_table',to_regclass('ops.customer_lead_board_state') IS NOT NULL,
    'guard_function',EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='ops' AND p.proname='guard_customer_lead_board_environment'
         AND p.prosecdef
         AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
    ),
    'environment_trigger',EXISTS(
      SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='ops' AND c.relname='customer_lead_board_state'
         AND t.tgname='customer_lead_board_environment' AND t.tgenabled<>'D'
    ),
    'immutable_trigger',EXISTS(
      SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='ops' AND c.relname='customer_lead_board_state'
         AND t.tgname='customer_lead_board_environment_immutable' AND t.tgenabled<>'D'
    ),
    'restrict_conversation_fk',EXISTS(
      SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
       JOIN pg_namespace n ON n.oid=r.relnamespace
       WHERE n.nspname='ops' AND r.relname='customer_lead_board_state'
         AND c.contype='f' AND c.confdeltype='r'
    ),
    'public_table_access',EXISTS(
      SELECT 1 FROM information_schema.table_privileges
       WHERE grantee='PUBLIC' AND table_schema='ops'
         AND table_name='customer_lead_board_state'
    ),
    'public_function_execute',EXISTS(
      SELECT 1 FROM information_schema.routine_privileges
       WHERE grantee='PUBLIC' AND specific_schema='ops'
         AND routine_name='guard_customer_lead_board_environment'
         AND privilege_type='EXECUTE'
    )
  ) state`);
  return rows[0].state;
}

function installationOk(state) {
  return state.board_table === true
    && state.guard_function === true
    && state.environment_trigger === true
    && state.immutable_trigger === true
    && state.restrict_conversation_fk === true
    && state.public_table_access === false
    && state.public_function_execute === false;
}

function anyInstalled(state) {
  return state.board_table || state.guard_function
    || state.environment_trigger || state.immutable_trigger;
}

async function probeBehavior(client) {
  const conversation = await client.query(
    `SELECT id FROM core.conversations
      WHERE environment='prod' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  );
  if (!conversation.rowCount) throw new Error('prod_probe_conversation_missing');
  const conversationId = conversation.rows[0].id;

  await client.query('SAVEPOINT customer_board_probe');
  await client.query(
    `INSERT INTO ops.customer_lead_board_state(
       environment,conversation_id,manual_lane,updated_by
     ) VALUES ('prod',$1,'atendimento','migration:0196:probe')`,
    [conversationId],
  );
  const valid = await client.query(
    `SELECT count(*)::int AS total FROM ops.customer_lead_board_state
      WHERE environment='prod' AND conversation_id=$1
        AND manual_lane='atendimento' AND version=1`,
    [conversationId],
  );
  if (Number(valid.rows[0].total) !== 1) throw new Error('valid_probe_failed');
  await client.query('ROLLBACK TO SAVEPOINT customer_board_probe');

  await client.query('SAVEPOINT customer_board_cross_environment_probe');
  let blocked = false;
  try {
    await client.query(
      `INSERT INTO ops.customer_lead_board_state(
         environment,conversation_id,updated_by
       ) VALUES ('test',$1,'migration:0196:probe')`,
      [conversationId],
    );
  } catch (error) {
    blocked = error && error.code === '23503';
  }
  await client.query('ROLLBACK TO SAVEPOINT customer_board_cross_environment_probe');
  if (!blocked) throw new Error('cross_environment_probe_not_blocked');
}

async function reconciliation(client) {
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'rows',(SELECT count(*) FROM ops.customer_lead_board_state),
    'cross_environment_rows',(SELECT count(*)
      FROM ops.customer_lead_board_state state
      LEFT JOIN core.conversations conversation
        ON conversation.id=state.conversation_id
       AND conversation.environment=state.environment
     WHERE conversation.id IS NULL),
    'invalid_manual_lanes',(SELECT count(*) FROM ops.customer_lead_board_state
      WHERE manual_lane IS NOT NULL
        AND manual_lane NOT IN ('novo','atendimento','orcamento','perdido'))
  ) state`);
  return rows[0].state;
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
    if (anyInstalled(before)) {
      throw new Error(installationOk(before)
        ? 'migration_already_applied'
        : `partial_migration_state:${JSON.stringify(before)}`);
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='180s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='240s'`);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0196'))`);
    await client.query(readFileSync(path.join(root, 'db', 'migrations', migrationFile), 'utf8'));

    const inside = await installationState(client);
    if (!installationOk(inside)) {
      throw new Error(`object_verification_failed:${JSON.stringify(inside)}`);
    }
    await probeBehavior(client);
    const insideReconciliation = await reconciliation(client);
    if (Number(insideReconciliation.cross_environment_rows) !== 0
      || Number(insideReconciliation.invalid_manual_lanes) !== 0) {
      throw new Error(`reconciliation_failed:${JSON.stringify(insideReconciliation)}`);
    }

    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    transactionFinished = true;

    const outside = await installationState(client);
    if (commit && !installationOk(outside)) throw new Error('post_commit_objects_missing');
    if (!commit && anyInstalled(outside)) throw new Error('dry_run_left_schema_changes');
    const outsideReconciliation = commit ? await reconciliation(client) : null;
    if (commit && (Number(outsideReconciliation.cross_environment_rows) !== 0
      || Number(outsideReconciliation.invalid_manual_lanes) !== 0)) {
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
  console.error(`PROD_CUSTOMER_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
