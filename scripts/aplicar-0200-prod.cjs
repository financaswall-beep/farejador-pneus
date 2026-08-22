#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const root = path.resolve(__dirname, '..');
const migrationFile = '0200_finance_credit_lifecycle.sql';
const commit = process.argv.includes('--commit');

function assertGuards() {
  if (process.env.ALLOW_PROD_FINANCE_MIGRATION !== '0200') {
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
  const sql = readFileSync(path.join(root, 'db', 'migrations', migrationFile), 'utf8');
  if (/(^|\n)\s*(BEGIN|COMMIT|ROLLBACK);\s*($|\n)/i.test(sql)) {
    throw new Error('migration_must_be_wrapped_only_by_executor');
  }
  return sql;
}

async function installationState(client) {
  const marker = (await client.query(
    `SELECT version,migration_name FROM ops.application_schema_state WHERE singleton=true`,
  )).rows[0] ?? null;
  const { rows } = await client.query(`SELECT jsonb_build_object(
    'receivable_events',to_regclass('finance.partner_receivable_events') IS NOT NULL,
    'payable_events',to_regclass('finance.partner_payable_events') IS NOT NULL,
    'order_refunds',to_regclass('finance.partner_order_refunds') IS NOT NULL,
    'receivables_effective',to_regclass('finance.partner_receivables_effective') IS NOT NULL,
    'payables_effective',to_regclass('finance.partner_payables_effective') IS NOT NULL,
    'relations',(SELECT count(*)::int FROM (VALUES
      (to_regclass('finance.partner_receivable_events')),
      (to_regclass('finance.partner_payable_events')),
      (to_regclass('finance.partner_order_refunds')),
      (to_regclass('finance.partner_receivables_effective')),
      (to_regclass('finance.partner_payables_effective'))
    ) relation(oid) WHERE oid IS NOT NULL),
    'rls_tables',(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='finance' AND c.relname IN (
        'partner_receivable_events','partner_payable_events','partner_order_refunds'
      ) AND c.relrowsecurity),
    'constraints',(SELECT count(*)::int FROM pg_constraint WHERE convalidated AND conname IN (
      'partner_receivables_status_check','matriz_ledger_payments_payment_kind_check',
      'matriz_ledger_payments_kind_check'
    )),
    'triggers',(SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
      'env_match_partner_receivable_event_unit','env_match_partner_receivable_event_parent',
      'env_match_partner_receivable_event_installment','env_match_partner_payable_event_unit',
      'env_match_partner_payable_event_parent','env_match_partner_order_refund_unit',
      'env_match_partner_order_refund_order','partner_receivable_events_business_time_guard',
      'partner_payable_events_business_time_guard','partner_order_refunds_business_time_guard',
      'partner_receivable_events_immutable','partner_payable_events_immutable',
      'partner_order_refunds_immutable','partner_receivable_event_integrity',
      'partner_receivable_event_sync','partner_payable_event_integrity',
      'partner_payable_event_sync','partner_receivable_capture_closed_state',
      'partner_installment_capture_closed_state','partner_payable_capture_closed_state',
      'partner_receivable_cancel_refund','partner_order_cash_refund',
      'source_linked_partner_receivable_guard'
    )),
    'public_privileges',(SELECT count(*)::int FROM information_schema.table_privileges
      WHERE table_schema='finance' AND table_name IN (
        'partner_receivable_events','partner_payable_events','partner_order_refunds',
        'partner_receivables_effective','partner_payables_effective'
      ) AND grantee='PUBLIC'),
    'prod_units',(SELECT count(*)::int FROM core.units WHERE environment='prod')
  ) state`);
  const state = { marker, ...rows[0].state,
    negative_receivable_balances: 0, negative_payable_balances: 0 };
  if (Number(state.relations) === 5) {
    const balances = await client.query(`SELECT
      (SELECT count(*)::int FROM finance.partner_receivables_effective
        WHERE received_amount<0 OR written_off_amount<0 OR open_amount<0)
        negative_receivable_balances,
      (SELECT count(*)::int FROM finance.partner_payables_effective
        WHERE paid_amount<0 OR open_amount<0) negative_payable_balances`);
    Object.assign(state, balances.rows[0]);
  }
  return state;
}

function installed(state) {
  return Number(state.marker?.version) === 200
    && state.marker?.migration_name === migrationFile
    && state.receivable_events && state.payable_events && state.order_refunds
    && state.receivables_effective && state.payables_effective
    && Number(state.rls_tables) === 3
    && Number(state.constraints) === 3
    && Number(state.triggers) === 23
    && Number(state.public_privileges) === 0
    && Number(state.negative_receivable_balances) === 0
    && Number(state.negative_payable_balances) === 0
    && Number(state.prod_units) > 0;
}

function pristineBefore(state) {
  return Number(state.marker?.version) === 199
    && state.marker?.migration_name === '0199_system_continuity.sql'
    && !state.receivable_events && !state.payable_events && !state.order_refunds
    && state.receivables_effective && !state.payables_effective
    && Number(state.rls_tables) === 0
    && Number(state.triggers) === 0
    && Number(state.prod_units) > 0;
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
    if (installed(before)) throw new Error('migration_already_applied');
    if (!pristineBefore(before)) throw new Error(`unexpected_prestate:${JSON.stringify(before)}`);

    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='240s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='300s'`);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0200'))`);
    await client.query(migrationSql());

    const inside = await installationState(client);
    if (!installed(inside)) throw new Error(`object_verification_failed:${JSON.stringify(inside)}`);

    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    transactionFinished = true;
    const outside = await installationState(client);
    if (commit && !installed(outside)) throw new Error('post_commit_objects_missing');
    if (!commit && !pristineBefore(outside)) throw new Error('dry_run_left_schema_changes');

    console.log(JSON.stringify({
      environment: 'prod', mode: commit ? 'commit' : 'dry-run',
      migration: migrationFile, before, verified_state: commit ? outside : inside,
    }, null, 2));
  } catch (error) {
    if (!transactionFinished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`PROD_FINANCE_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
