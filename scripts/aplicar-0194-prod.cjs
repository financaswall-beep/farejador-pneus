#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const root = path.resolve(__dirname, '..');
const migrationFile = '0194_network_audit_corrections.sql';
const commit = process.argv.includes('--commit');

function assertGuards() {
  if (process.env.ALLOW_PROD_NETWORK_MIGRATION !== '0194') throw new Error('explicit_authorization_required');
  if (process.env.FAREJADOR_ENV !== 'prod') throw new Error('prod_environment_required');
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  if (!process.env.PROD_BACKUP_FILE || !process.env.PROD_BACKUP_SHA256) throw new Error('verified_backup_required');
  const actual = createHash('sha256').update(readFileSync(process.env.PROD_BACKUP_FILE)).digest('hex');
  if (actual.toLowerCase() !== process.env.PROD_BACKUP_SHA256.toLowerCase()) throw new Error('backup_hash_mismatch');
  const manifest = auditMigrationManifest(root);
  if (!manifest.ok) throw new Error(`migration_manifest_invalid:${manifest.errors.join('|')}`);
}

async function installationState(client) {
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'credential_columns',(SELECT count(*)=3 FROM pg_attribute WHERE
      attrelid='network.partner_access_tokens'::regclass AND NOT attisdropped AND
      attname IN ('raw_access_consumed_at','recovery_token_hash','recovery_token_consumed_at')),
    'recovery_index',to_regclass('network.partner_access_tokens_recovery_hash_uniq') IS NOT NULL,
    'consumption_trigger',EXISTS(SELECT 1 FROM pg_trigger WHERE
      tgrelid='network.partner_access_tokens'::regclass AND
      tgname='partner_raw_access_consumption_immutable' AND tgenabled<>'D'),
    'commercial_constraint',EXISTS(SELECT 1 FROM pg_constraint WHERE
      conrelid='network.partners'::regclass AND conname='partner_commercial_terms_complete_check' AND convalidated),
    'routing_table',to_regclass('ops.partner_routing_decisions') IS NOT NULL,
    'token_validator',EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='network' AND p.proname='validate_partner_token'
        AND pg_get_functiondef(p.oid) LIKE '%recovery_token_hash%'),
    'partner_role_blocked',CASE WHEN to_regclass('ops.partner_routing_decisions') IS NULL THEN false
      ELSE NOT has_table_privilege('farejador_partner_app','ops.partner_routing_decisions','SELECT') END
  ) state`);
  return rows[0].state;
}

async function sourceCounts(client) {
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'partners',(SELECT count(*) FROM network.partners),
    'partner_units',(SELECT count(*) FROM network.partner_units),
    'access_tokens',(SELECT count(*) FROM network.partner_access_tokens),
    'conversations',(SELECT count(*) FROM core.conversations),
    'conversation_facts',(SELECT count(*) FROM analytics.conversation_facts),
    'orders',(SELECT count(*) FROM commerce.orders),
    'partner_orders',(SELECT count(*) FROM commerce.partner_orders)
  ) counts`);
  return rows[0].counts;
}

async function reconciliation(client) {
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'invalid_terms',(SELECT count(*) FROM network.partners WHERE NOT (
      (commercial_model='commission' AND commission_percent IS NOT NULL AND monthly_fee IS NULL) OR
      (commercial_model='monthly' AND commission_percent IS NULL AND monthly_fee IS NOT NULL) OR
      (commercial_model='hybrid' AND commission_percent IS NOT NULL AND monthly_fee IS NOT NULL))),
    'owners_with_reusable_raw_key',(SELECT count(*) FROM network.partner_access_tokens WHERE
      role='owner' AND raw_access_consumed_at IS NULL AND
      (login_password_hash IS NOT NULL OR person_id IS NOT NULL)),
    'routable_prod_fixtures',(SELECT count(*) FROM network.partner_units WHERE
      environment='prod' AND slug LIKE 'zz-teste-%' AND deleted_at IS NULL AND accepts_network_orders),
    'routing_conversation_env_mismatch',(SELECT count(*) FROM ops.partner_routing_decisions d
      JOIN core.conversations c ON c.id=d.conversation_id WHERE c.environment<>d.environment),
    'routing_unit_env_mismatch',(SELECT count(*) FROM ops.partner_routing_decisions d
      JOIN core.units u ON u.id=d.unit_id WHERE u.environment<>d.environment),
    'invalid_routing_shape',(SELECT count(*) FROM ops.partner_routing_decisions WHERE
      (decision_kind IN ('partner','only_far'))<>(unit_id IS NOT NULL))
  ) state`);
  return rows[0].state;
}

const allTrue = (state) => Object.values(state).every((value) => value === true);
const allZero = (state) => Object.values(state).every((value) => Number(value) === 0);

async function main() {
  assertGuards();
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let transactionFinished = false;
  try {
    const beforeInstall = await installationState(client);
    if (Object.values(beforeInstall).some(Boolean)) throw new Error(
      allTrue(beforeInstall) ? 'migration_already_applied' : `partial_migration_state:${JSON.stringify(beforeInstall)}`,
    );
    const beforeCounts = await sourceCounts(client);
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='180s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='240s'`);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0194'))`);
    await client.query(readFileSync(path.join(root, 'db', 'migrations', migrationFile), 'utf8'));
    const insideInstall = await installationState(client);
    const insideReconciliation = await reconciliation(client);
    if (!allTrue(insideInstall)) throw new Error(`object_verification_failed:${JSON.stringify(insideInstall)}`);
    if (!allZero(insideReconciliation)) throw new Error(`reconciliation_failed:${JSON.stringify(insideReconciliation)}`);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    transactionFinished = true;

    const afterCounts = await sourceCounts(client);
    if (JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts)) throw new Error('source_counts_changed');
    const outsideInstall = await installationState(client);
    if (commit && !allTrue(outsideInstall)) throw new Error('post_commit_objects_missing');
    if (!commit && Object.values(outsideInstall).some(Boolean)) throw new Error('dry_run_left_schema_changes');
    const outsideReconciliation = commit ? await reconciliation(client) : null;
    if (commit && !allZero(outsideReconciliation)) throw new Error('post_commit_reconciliation_failed');
    console.log(JSON.stringify({ environment:'prod',mode:commit?'commit':'dry-run',migration:migrationFile,
      source_counts_preserved:true,objects:commit?outsideInstall:insideInstall,
      reconciliation:commit?outsideReconciliation:insideReconciliation }, null, 2));
  } catch (error) {
    if (!transactionFinished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`PROD_NETWORK_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
