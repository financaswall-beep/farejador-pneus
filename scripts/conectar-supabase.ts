/**
 * Conecta no Supabase do Farejador e lista tabelas/schemas.
 * Apenas leitura. Não altera nada.
 */

import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[ERRO] DATABASE_URL ausente. Rode com: npx tsx --env-file=.env scripts/conectar-supabase.ts');
  process.exit(1);
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log('Conectando no Supabase...\n');
  await client.connect();

  // Lista schemas (exceto os do sistema)
  const schemas = await client.query(`
    SELECT schema_name 
    FROM information_schema.schemata 
    WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1')
    ORDER BY schema_name;
  `);

  console.log('=== SCHEMAS ===');
  for (const row of schemas.rows) {
    console.log(`  - ${row.schema_name}`);
  }

  // Lista tabelas do schema public
  const tables = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name;
  `);

  console.log('\n=== TABELAS (public) ===');
  for (const row of tables.rows) {
    console.log(`  - ${row.table_name}`);
  }

  // Conta registros na raw_events (tabela principal do farejador)
  try {
    const count = await client.query('SELECT COUNT(*) as total FROM raw.raw_events;');
    console.log(`\n=== raw.raw_events: ${count.rows[0].total} registros ===`);
  } catch {
    console.log('\n=== raw.raw_events: tabela não encontrada ===');
  }

  await client.end();
  console.log('\nConexão encerrada.');
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
