/**
 * Auditoria de prontidao do livro central. Nao grava nada: a sessao inteira
 * roda dentro de BEGIN READ ONLY e sempre termina em ROLLBACK.
 *
 * Uso:
 *   node --env-file=.env.preview.pooler scripts/auditar-ledger-prod-readonly.cjs
 */
const { Client } = require('pg');

const expectedEnvironment = process.env.FAREJADOR_ENV;
if (expectedEnvironment !== 'prod') {
  throw new Error('prod_environment_required');
}
if (!process.env.DATABASE_URL) throw new Error('database_url_required');

const objects = [
  ['0145', 'function', 'finance.protect_matriz_receipt_expense()'],
  ['0146', 'table', 'finance.matriz_commission_reversals'],
  ['0147', 'table', 'finance.matriz_inventory_adjustments'],
  ['0148', 'function', 'finance.matriz_payroll_assignment_gaps(env_t,date)'],
  ['0149', 'table', 'finance.matriz_ledger_transactions'],
  ['0149', 'table', 'finance.matriz_ledger_entries'],
  ['0149', 'table', 'finance.matriz_ledger_payments'],
  ['0150', 'function', 'finance.matriz_stage3_ledger_reconciliation(env_t)'],
  ['0151', 'table', 'finance.matriz_partner_monthly_fees'],
];

const sourceTables = [
  ['wholesale_orders', 'commerce.wholesale_orders'],
  ['retail_orders', 'commerce.orders'],
  ['wholesale_purchases', 'commerce.wholesale_purchases'],
  ['expenses', 'commerce.matriz_expenses'],
  ['commission_entries', 'network.commission_entries'],
  ['payroll_items', 'finance.matriz_payroll_items'],
  ['marketing_campaign_days', 'marketing.meta_insights_daily'],
];

async function tableExists(client, table) {
  const result = await client.query(
    'SELECT to_regclass($1)::text value',
    [table],
  );
  return Boolean(result.rows[0]?.value);
}

async function functionExists(client, signature) {
  const result = await client.query(
    'SELECT to_regprocedure($1)::text value',
    [signature],
  );
  return Boolean(result.rows[0]?.value);
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const installed = [];
    for (const [migration, kind, name] of objects) {
      const present = kind === 'table'
        ? await tableExists(client, name)
        : await functionExists(client, name);
      installed.push({ migration, object: name, present });
    }

    const sourceCounts = {};
    for (const [label, table] of sourceTables) {
      if (!await tableExists(client, table)) {
        sourceCounts[label] = null;
        continue;
      }
      const environmentColumn = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema=$1 AND table_name=$2 AND column_name='environment'
         ) value`,
        table.split('.'),
      );
      if (!environmentColumn.rows[0]?.value) {
        sourceCounts[label] = null;
        continue;
      }
      const count = await client.query(
        `SELECT count(*)::int value FROM ${table} WHERE environment='prod'`,
      );
      sourceCounts[label] = count.rows[0]?.value ?? 0;
    }

    const centralReady = installed
      .filter((item) => ['0149', '0150', '0151'].includes(item.migration))
      .every((item) => item.present);
    const databaseSize = await client.query(
      `SELECT pg_database_size(current_database())::bigint::text bytes,
              pg_size_pretty(pg_database_size(current_database())) pretty`,
    );
    console.log(JSON.stringify({
      mode: 'read_only',
      environment: expectedEnvironment,
      database_size: databaseSize.rows[0],
      migrations_0145_0151: installed,
      central_schema_ready: centralReady,
      central_writer_flag: process.env.MATRIZ_CENTRAL_LEDGER === 'true',
      central_read_flag: process.env.MATRIZ_CENTRAL_LEDGER_READ === 'true',
      source_row_counts_prod: sourceCounts,
    }, null, 2));
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`AUDIT_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
