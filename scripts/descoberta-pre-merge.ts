/**
 * Descoberta de schema antes de mexer no commerce.
 * Lista colunas, constraints, enums, contagens.
 */
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL ausente'); process.exit(1); }

const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TABLES = [
  'products', 'tire_specs', 'vehicle_models', 'vehicle_fitments',
  'product_prices', 'stock_levels', 'delivery_zones', 'geo_resolutions',
  'orders', 'order_items', 'store_policies', 'fitment_discoveries',
  'import_batches',
];

async function main() {
  await client.connect();

  console.log('=== ENUM env_t ===');
  const enums = await client.query(
    `SELECT enumlabel FROM pg_enum e
     JOIN pg_type t ON e.enumtypid = t.oid
     WHERE t.typname = 'env_t'
     ORDER BY enumsortorder;`,
  );
  console.log('  valores aceitos:', enums.rows.map((r) => r.enumlabel).join(', '));
  console.log();

  for (const t of TABLES) {
    console.log(`=== commerce.${t} ===`);
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name=$1
       ORDER BY ordinal_position;`,
      [t],
    );
    if (cols.rows.length === 0) {
      console.log('  (tabela nao existe)');
      console.log();
      continue;
    }
    for (const c of cols.rows) {
      console.log(`  ${c.column_name}\t${c.data_type}\t${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}${c.column_default ? ' DEFAULT ' + c.column_default : ''}`);
    }

    const cons = await client.query(
      `SELECT conname, contype, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = ('commerce.' || $1)::regclass
       ORDER BY contype, conname;`,
      [t],
    );
    if (cons.rows.length > 0) {
      console.log('  constraints:');
      for (const c of cons.rows) console.log(`    [${c.contype}] ${c.conname}: ${c.def}`);
    }

    const cnt = await client.query(`SELECT environment, COUNT(*) AS n FROM commerce.${t} GROUP BY environment ORDER BY environment;`)
      .catch(() => null);
    if (cnt) {
      console.log('  contagem por env:');
      if (cnt.rows.length === 0) console.log('    (vazia)');
      for (const r of cnt.rows) console.log(`    ${r.environment} = ${r.n}`);
    }
    console.log();
  }

  // O que mais referencia commerce em outros schemas (FKs entrantes)
  console.log('=== FKs ENTRANTES em commerce.* ===');
  const fks = await client.query(
    `SELECT
       conrelid::regclass AS tabela_origem,
       conname,
       pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE contype = 'f'
       AND confrelid::regclass::text LIKE 'commerce.%'
     ORDER BY conrelid::regclass::text;`,
  );
  for (const f of fks.rows) console.log(`  ${f.tabela_origem} -> ${f.def}`);

  await client.end();
}

main().catch((err) => { console.error('Erro:', err.message); process.exit(1); });
