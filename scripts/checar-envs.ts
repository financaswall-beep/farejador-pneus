/**
 * Conta quantos registros existem em cada environment em commerce.
 * Apenas SELECT.
 */
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL ausente'); process.exit(1); }

const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  console.log('=== DISTRIBUICAO POR ENVIRONMENT EM COMMERCE ===\n');

  const tables = [
    'vehicle_models',
    'vehicle_fitments',
    'tire_specs',
    'products',
    'product_prices',
    'stock_levels',
    'orders',
  ];

  for (const t of tables) {
    try {
      const r = await client.query(
        `SELECT environment, COUNT(*) AS n FROM commerce.${t} GROUP BY environment ORDER BY environment;`,
      );
      console.log(`commerce.${t}:`);
      if (r.rows.length === 0) console.log('  (vazia)');
      for (const row of r.rows) console.log(`  ${row.environment} = ${row.n}`);
      console.log();
    } catch (err: any) {
      console.log(`commerce.${t}: erro -> ${err.message}\n`);
    }
  }

  // Detalhe: produtos por environment, primeiros 10 de cada
  console.log('--- PRODUTOS DE PNEU EM PROD (primeiros 20) ---');
  const prodProd = await client.query(
    `SELECT id, product_name, brand
     FROM commerce.products
     WHERE environment = 'prod' AND deleted_at IS NULL
     ORDER BY product_name
     LIMIT 20;`,
  );
  for (const r of prodProd.rows) console.log(`  ${r.product_name} | ${r.brand ?? '-'}`);
  if (prodProd.rows.length === 0) console.log('  (zero)');
  console.log();

  console.log('--- PRODUTOS DE PNEU EM TEST (primeiros 20) ---');
  const prodTest = await client.query(
    `SELECT id, product_name, brand
     FROM commerce.products
     WHERE environment = 'test' AND deleted_at IS NULL
     ORDER BY product_name
     LIMIT 20;`,
  );
  for (const r of prodTest.rows) console.log(`  ${r.product_name} | ${r.brand ?? '-'}`);
  if (prodTest.rows.length === 0) console.log('  (zero)');
  console.log();

  // Quantos vehicle_models em cada env e amostra
  console.log('--- VEHICLE_MODELS EM PROD (amostra 10) ---');
  const vmProd = await client.query(
    `SELECT make, model, variant, year_start, year_end
     FROM commerce.vehicle_models
     WHERE environment='prod' AND deleted_at IS NULL
     ORDER BY make, model LIMIT 10;`,
  );
  for (const r of vmProd.rows) console.log(`  ${r.make} ${r.model} ${r.variant ?? ''} (${r.year_start}-${r.year_end})`);
  if (vmProd.rows.length === 0) console.log('  (zero)');
  console.log();

  console.log('--- VEHICLE_MODELS EM TEST (amostra 10) ---');
  const vmTest = await client.query(
    `SELECT make, model, variant, year_start, year_end
     FROM commerce.vehicle_models
     WHERE environment='test' AND deleted_at IS NULL
     ORDER BY make, model LIMIT 10;`,
  );
  for (const r of vmTest.rows) console.log(`  ${r.make} ${r.model} ${r.variant ?? ''} (${r.year_start}-${r.year_end})`);
  if (vmTest.rows.length === 0) console.log('  (zero)');

  await client.end();
}

main().catch((err) => { console.error('Erro:', err.message); process.exit(1); });
