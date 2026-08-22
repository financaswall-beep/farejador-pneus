#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const root = path.resolve(__dirname, '..');
const migrationFile = '0198_marketing_integrity.sql';
const commit = process.argv.includes('--commit');

function assertGuards() {
  if (process.env.ALLOW_PROD_MARKETING_MIGRATION !== '0198') {
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
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'constraints',(SELECT count(*)::int FROM pg_constraint
      WHERE conname IN (
        'meta_sync_runs_lifecycle_check',
        'meta_messaging_provider_key_shape_check',
        'campaign_scopes_classification_text_check'
      ) AND convalidated),
    'running_index',(SELECT count(*)::int FROM pg_indexes
      WHERE schemaname='marketing' AND indexname='meta_sync_runs_one_running_uniq'),
    'functions',(SELECT count(*)::int FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='marketing' AND p.proname IN (
        'validate_ad_referral_causality',
        'enforce_ad_referral_identity_immutable',
        'validate_order_attribution_causality',
        'validate_meta_messaging_match'
      )),
    'triggers',(SELECT count(*)::int FROM pg_trigger
      WHERE tgname IN (
        'ad_referral_causality_guard',
        'ad_referral_identity_immutability_guard',
        'order_attribution_causality_guard',
        'meta_messaging_match_causality_guard'
      ) AND NOT tgisinternal AND tgenabled<>'D'),
    'public_execute',(SELECT count(*)::int
      FROM information_schema.routine_privileges
      WHERE grantee='PUBLIC' AND specific_schema='marketing'
        AND routine_name IN (
          'validate_ad_referral_causality',
          'enforce_ad_referral_identity_immutable',
          'validate_order_attribution_causality',
          'validate_meta_messaging_match'
        ) AND privilege_type='EXECUTE'),
    'partner_execute',(SELECT count(*)::int
      FROM information_schema.routine_privileges
      WHERE grantee IN ('partner_app','farejador_partner_app')
        AND specific_schema='marketing' AND routine_name IN (
          'validate_ad_referral_causality',
          'enforce_ad_referral_identity_immutable',
          'validate_order_attribution_causality',
          'validate_meta_messaging_match'
        ) AND privilege_type='EXECUTE')
  ) state`);
  return rows[0].state;
}

function installationOk(state) {
  return Number(state.constraints) === 3
    && Number(state.running_index) === 1
    && Number(state.functions) === 4
    && Number(state.triggers) === 4
    && Number(state.public_execute) === 0
    && Number(state.partner_execute) === 0;
}

function anyInstalled(state) {
  return Number(state.constraints) > 0
    || Number(state.running_index) > 0
    || Number(state.functions) > 0
    || Number(state.triggers) > 0;
}

async function reconciliation(client) {
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'stale_running',(SELECT count(*) FROM marketing.meta_sync_runs
      WHERE status='running' AND started_at<now()-interval '1 hour'),
    'duplicate_running',(SELECT count(*) FROM (
      SELECT environment,source FROM marketing.meta_sync_runs
       WHERE status='running' GROUP BY environment,source HAVING count(*)>1
    ) duplicates),
    'invalid_sync_lifecycle',(SELECT count(*) FROM marketing.meta_sync_runs
      WHERE (status='running' AND finished_at IS NOT NULL)
         OR (status IN ('succeeded','failed') AND finished_at IS NULL)),
    'old_pending_meta',(SELECT count(*) FROM marketing.meta_messaging_referrals
      WHERE status='pending' AND created_at<now()-interval '7 days'),
    'invalid_provider_key',(SELECT count(*) FROM marketing.meta_messaging_referrals
      WHERE provider_event_key !~ '^[a-f0-9]{64}$'),
    'referral_conversation_mismatch',(SELECT count(*) FROM marketing.ad_referrals r
      LEFT JOIN core.messages m
        ON m.environment=r.environment AND m.id=r.source_message_id
      WHERE m.id IS NULL OR m.conversation_id<>r.conversation_id),
    'attribution_causality_mismatch',(SELECT count(*)
      FROM marketing.order_attributions a
      LEFT JOIN marketing.ad_referrals r
        ON r.environment=a.environment AND r.id=a.referral_id
      WHERE r.id IS NULL OR a.conversation_id<>r.conversation_id
         OR a.realized_at<r.captured_at
         OR a.realized_at>=r.captured_at+interval '7 days'),
    'meta_match_mismatch',(SELECT count(*) FROM marketing.meta_messaging_referrals r
      LEFT JOIN core.messages m
        ON m.environment=r.environment AND m.id=r.matched_message_id
      WHERE r.status='matched'
        AND (m.id IS NULL OR m.conversation_id<>r.matched_conversation_id)),
    'invalid_campaign_scope',(SELECT count(*) FROM marketing.campaign_scopes
      WHERE scope<>'pending'
        AND (length(btrim(classified_by))=0 OR length(btrim(classification_reason))=0))
  ) state`);
  return rows[0].state;
}

const allZero = (state) => Object.values(state).every((value) => Number(value) === 0);

async function probeBehavior(client) {
  const referral = await client.query(
    `SELECT id FROM marketing.ad_referrals ORDER BY captured_at DESC LIMIT 1`,
  );
  if (!referral.rowCount) return;
  await client.query('SAVEPOINT marketing_immutability_probe');
  let blocked = false;
  try {
    await client.query(
      `UPDATE marketing.ad_referrals SET captured_at=captured_at+interval '1 second'
        WHERE id=$1`,
      [referral.rows[0].id],
    );
  } catch (error) {
    blocked = error && error.code === '23001';
  }
  await client.query('ROLLBACK TO SAVEPOINT marketing_immutability_probe');
  if (!blocked) throw new Error('referral_immutability_probe_not_blocked');
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
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0198'))`);
    await client.query(migrationSql());

    const inside = await installationState(client);
    if (!installationOk(inside)) {
      throw new Error(`object_verification_failed:${JSON.stringify(inside)}`);
    }
    await probeBehavior(client);
    const insideReconciliation = await reconciliation(client);
    if (!allZero(insideReconciliation)) {
      throw new Error(`reconciliation_failed:${JSON.stringify(insideReconciliation)}`);
    }

    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    transactionFinished = true;

    const outside = await installationState(client);
    if (commit && !installationOk(outside)) throw new Error('post_commit_objects_missing');
    if (!commit && anyInstalled(outside)) throw new Error('dry_run_left_schema_changes');
    const outsideReconciliation = commit ? await reconciliation(client) : null;
    if (commit && !allZero(outsideReconciliation)) {
      throw new Error(`post_commit_reconciliation_failed:${JSON.stringify(outsideReconciliation)}`);
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
  console.error(`PROD_MARKETING_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
