'use strict';
const { Client } = require('pg');

const environment = process.env.FAREJADOR_ENV;
if (!['prod', 'test'].includes(environment)) {
  throw new Error('FAREJADOR_ENV deve ser informado explicitamente como prod ou test');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='30s'");

  console.log(`Estrutura do schema analytics no banco de ${environment}.`);

  // Lista tabelas do schema analytics
  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='analytics' AND table_type='BASE TABLE'
    ORDER BY table_name;
  `);

  for (const t of tables.rows) {
    console.log(`\n=== analytics.${t.table_name} ===`);
    const cols = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name=$1
      ORDER BY ordinal_position;
    `, [t.table_name]);
    for (const c of cols.rows) {
      console.log(`  ${c.column_name}\t${c.data_type}\t${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    }
  }

  await client.query('ROLLBACK');
}
main()
  .catch(async (e) => {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => client.end().catch(() => undefined));
