/**
 * Aplica 0145-0151 em producao numa unica transacao.
 * Nao liga feature flags e nao executa backfill.
 */
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const migrationFiles = [
  '0145_matriz_receipt_expense_integrity.sql',
  '0146_matriz_commission_reversal_refunds.sql',
  '0147_matriz_inventory_financial_adjustments.sql',
  '0148_matriz_payroll_employment_and_assignment.sql',
  '0149_matriz_central_ledger_foundation.sql',
  '0150_matriz_stage3_ledger_reconciliation.sql',
  '0151_matriz_partner_monthly_fees.sql',
];
const expectedBackupHash =
  'B14A6581E64EF5183430EC71CD77A78C90070FB90DF9C103B47837FC2CB2D744';
const backupPath = process.env.PROD_BACKUP_FILE;

function assertLocalGuards() {
  if (process.env.ALLOW_PROD_LEDGER_MIGRATIONS !== '0145-0151') {
    throw new Error('explicit_migration_authorization_required');
  }
  if (process.env.FAREJADOR_ENV !== 'prod') throw new Error('prod_environment_required');
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  if (process.env.MATRIZ_CENTRAL_LEDGER === 'true'
    || process.env.MATRIZ_CENTRAL_LEDGER_READ === 'true') {
    throw new Error('central_ledger_flags_must_be_disabled');
  }
  if (!backupPath) throw new Error('verified_backup_required');
  const actualBackupHash = createHash('sha256')
    .update(readFileSync(backupPath)).digest('hex').toUpperCase();
  if (actualBackupHash !== expectedBackupHash) throw new Error('backup_hash_mismatch');
  const manifest = auditMigrationManifest(path.resolve(__dirname, '..'));
  if (!manifest.ok) throw new Error(`migration_manifest_invalid:${manifest.errors.join('|')}`);
}

async function objectState(client) {
  const result = await client.query(
    `SELECT jsonb_build_object(
       '0145',to_regprocedure('finance.protect_matriz_receipt_expense()') IS NOT NULL,
       '0146',to_regclass('finance.matriz_commission_reversals') IS NOT NULL,
       '0147',to_regclass('finance.matriz_inventory_adjustments') IS NOT NULL,
       '0148',to_regprocedure(
         'finance.matriz_payroll_assignment_gaps(env_t,date)') IS NOT NULL,
       '0149',to_regclass('finance.matriz_ledger_transactions') IS NOT NULL
         AND to_regclass('finance.matriz_ledger_entries') IS NOT NULL
         AND to_regclass('finance.matriz_ledger_payments') IS NOT NULL,
       '0150',to_regprocedure(
         'finance.matriz_stage3_ledger_reconciliation(env_t)') IS NOT NULL,
       '0151',to_regclass('finance.matriz_partner_monthly_fees') IS NOT NULL
     ) state`,
  );
  return result.rows[0].state;
}

async function sourceCounts(client) {
  const result = await client.query(
    `SELECT jsonb_build_object(
       'wholesale_orders',(SELECT count(*) FROM commerce.wholesale_orders
         WHERE environment='prod'),
       'retail_orders',(SELECT count(*) FROM commerce.orders
         WHERE environment='prod'),
       'wholesale_purchases',(SELECT count(*) FROM commerce.wholesale_purchases
         WHERE environment='prod'),
       'expenses',(SELECT count(*) FROM commerce.matriz_expenses
         WHERE environment='prod'),
       'commission_entries',(SELECT count(*) FROM network.commission_entries
         WHERE environment='prod'),
       'payroll_items',(SELECT count(*) FROM finance.matriz_payroll_items
         WHERE environment='prod'),
       'marketing_campaign_days',(SELECT count(*) FROM marketing.meta_insights_daily
         WHERE environment='prod')
     ) counts`,
  );
  return result.rows[0].counts;
}

async function main() {
  assertLocalGuards();
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const beforeCounts = await sourceCounts(client);
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='5s'`);
    await client.query(`SET LOCAL statement_timeout='120s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='180s'`);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('farejador:migrations:0145-0151'))`,
    );
    const before = await objectState(client);
    const installed = Object.values(before).filter(Boolean).length;
    if (installed > 0) {
      throw new Error(installed === migrationFiles.length
        ? 'migrations_already_applied'
        : `partial_migration_state:${JSON.stringify(before)}`);
    }
    for (const file of migrationFiles) {
      const sql = readFileSync(
        path.join(__dirname, '..', 'db', 'migrations', file),
        'utf8',
      );
      await client.query(sql);
      process.stdout.write(`APPLIED_IN_TRANSACTION:${file}\n`);
    }
    const inside = await objectState(client);
    if (Object.values(inside).some((value) => !value)) {
      throw new Error(`migration_verification_failed:${JSON.stringify(inside)}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  try {
    const after = await objectState(client);
    const afterCounts = await sourceCounts(client);
    const ledgerCounts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM finance.matriz_ledger_transactions) transactions,
         (SELECT count(*)::int FROM finance.matriz_ledger_entries) entries,
         (SELECT count(*)::int FROM finance.matriz_ledger_payments) payments`,
    );
    if (JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts)) {
      throw new Error('source_counts_changed');
    }
    console.log(JSON.stringify({
      environment: 'prod',
      transaction: 'committed',
      migrations: after,
      flags: { writer: false, reader: false },
      source_counts_preserved: true,
      central_rows: ledgerCounts.rows[0],
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`PROD_MIGRATION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
