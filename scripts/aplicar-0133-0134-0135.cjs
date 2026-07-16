// Aplicacao controlada das migrations 0133 -> 0134 -> 0135.
// Executa uma unica conexao, uma unica transacao e registra o historico remoto.
// Uso:
//   node scripts/aplicar-0133-0134-0135.cjs --env-file=.env.preview.pooler --apply
// Em testes descartaveis, DATABASE_URL pode ser fornecida pelo processo.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = [
  { file: '0133_matriz_collaborator_management.sql', version: '20260715132757', name: '0133_matriz_collaborator_management' },
  { file: '0134_audit_security_hotfix.sql', version: '20260716031237', name: '0134_audit_security_hotfix' },
  { file: '0135_payroll_history_and_integrity.sql', version: '20260716031238', name: '0135_payroll_history_and_integrity' },
];

function argValue(prefix) {
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function databaseUrl(envFile) {
  if (!envFile) {
    if (!process.env.DATABASE_URL) throw new Error('informe --env-file=<arquivo> ou DATABASE_URL');
    return process.env.DATABASE_URL;
  }
  const absolute = path.resolve(ROOT, envFile);
  const line = fs.readFileSync(absolute, 'utf8').split(/\r?\n/)
    .find((value) => value.startsWith('DATABASE_URL='));
  if (!line) throw new Error(`DATABASE_URL ausente em ${envFile}`);
  return line.slice('DATABASE_URL='.length).trim();
}

function migrationSql(file) {
  return fs.readFileSync(path.join(ROOT, 'db', 'migrations', file), 'utf8');
}

function connectionOptions(connectionString) {
  const hostname = new URL(connectionString).hostname;
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  return { connectionString, ssl: local ? false : { rejectUnauthorized: false } };
}

async function schemaState(client) {
  const result = await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='network' AND table_name='matriz_collaborators' AND column_name='job_title') AS job_title,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='network' AND table_name='matriz_collaborators' AND column_name='work_area') AS work_area,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='commerce' AND table_name='orders' AND column_name='seller_collaborator_id') AS retail_seller,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='commerce' AND table_name='wholesale_orders' AND column_name='seller_collaborator_id') AS wholesale_seller,
      to_regclass('network.matriz_collaborator_compensation') IS NOT NULL AS compensation,
      to_regclass('network.matriz_collaborator_commission_rules') IS NOT NULL AS commission_rules,
      to_regclass('finance.matriz_payroll_adjustments') IS NOT NULL AS payroll_adjustments,
      to_regclass('finance.matriz_payroll_periods') IS NOT NULL AS payroll_periods,
      to_regclass('finance.matriz_payroll_items') IS NOT NULL AS payroll_items,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='network' AND table_name='matriz_collaborator_compensation' AND column_name='id') AS compensation_history,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='network' AND table_name='matriz_collaborator_commission_rules' AND column_name='id') AS commission_history,
      COALESCE((SELECT 'security_invoker=true'=ANY(reloptions) FROM pg_class WHERE oid=to_regclass('commerce.partner_orders_full')), false) AS partner_view_secure
  `);
  return result.rows[0];
}

function all(state, keys) {
  return keys.every((key) => state[key] === true);
}

function any(state, keys) {
  return keys.some((key) => state[key] === true);
}

async function recordMigration(client, migration, sql) {
  const existing = await client.query(
    `SELECT version,name FROM supabase_migrations.schema_migrations
      WHERE version=$1 OR name=$2`,
    [migration.version, migration.name],
  );
  if (existing.rows.length > 0) {
    const exact = existing.rows.some((row) => row.version === migration.version && row.name === migration.name);
    if (!exact) throw new Error(`conflito no historico da migration ${migration.name}`);
    return;
  }
  await client.query(
    `INSERT INTO supabase_migrations.schema_migrations
       (version,statements,name,created_by)
     VALUES ($1,$2::text[],$3,$4)`,
    [migration.version, [sql], migration.name, 'codex-recovery-2026-07-16'],
  );
}

async function main() {
  const envFile = argValue('--env-file=');
  if (!process.argv.includes('--apply')) throw new Error('execucao bloqueada: informe --apply');

  const client = new Client(connectionOptions(databaseUrl(envFile)));
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador_migrations_0133_0135'))`);
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='120s'`);

    const baseKeys = ['job_title', 'work_area', 'retail_seller', 'wholesale_seller', 'compensation', 'commission_rules', 'payroll_adjustments', 'payroll_periods', 'payroll_items'];
    let state = await schemaState(client);
    if (any(state, baseKeys) && !all(state, baseKeys)) {
      throw new Error('schema 0133 parcialmente aplicado; operacao abortada sem alterar o banco');
    }

    const [base, security, history] = MIGRATIONS.map((migration) => ({ ...migration, sql: migrationSql(migration.file) }));

    if (!all(state, baseKeys)) await client.query(base.sql);
    state = await schemaState(client);
    if (!all(state, baseKeys)) throw new Error('validacao da 0133 falhou');
    await recordMigration(client, base, base.sql);

    await client.query(security.sql);
    state = await schemaState(client);
    if (!state.partner_view_secure) throw new Error('validacao da 0134 falhou');
    await recordMigration(client, security, security.sql);

    const historyKeys = ['compensation_history', 'commission_history'];
    if (any(state, historyKeys) && !all(state, historyKeys)) {
      throw new Error('schema 0135 parcialmente aplicado; operacao abortada');
    }
    if (!all(state, historyKeys)) await client.query(history.sql);
    state = await schemaState(client);
    if (!all(state, [...baseKeys, ...historyKeys, 'partner_view_secure'])) {
      throw new Error('validacao final das migrations falhou');
    }
    await recordMigration(client, history, history.sql);

    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, migrations: MIGRATIONS.map((migration) => migration.name), state }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`FALHOU: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
