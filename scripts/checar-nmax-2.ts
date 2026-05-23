/**
 * Investiga POR QUE find_compatible_tires retorna 0 mesmo tendo fitment.
 */

import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL ausente'); process.exit(1); }

const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  console.log('=== POR QUE find_compatible_tires VAZIA ===\n');

  const NMAX_ID = 'e5820ce6-b301-4e1c-88e7-da42a7544666';

  // 1. environment dos fitments
  const f = await client.query(
    `SELECT id, environment, vehicle_model_id, tire_spec_id, position, is_oem
     FROM commerce.vehicle_fitments
     WHERE vehicle_model_id = $1;`,
    [NMAX_ID],
  );
  console.log('Fitments com env:');
  for (const r of f.rows) console.log(' ', r);
  console.log();

  // 2. environment do vehicle_model
  const vm = await client.query(`SELECT id, environment, make, model FROM commerce.vehicle_models WHERE id = $1;`, [NMAX_ID]);
  console.log('Vehicle model:');
  for (const r of vm.rows) console.log(' ', r);
  console.log();

  // 3. environment dos tire_specs/products linkados
  const ts = await client.query(
    `SELECT ts.id AS tire_spec_id, ts.tire_size, ts.product_id, p.environment AS prod_env, p.product_name, p.brand, p.deleted_at
     FROM commerce.tire_specs ts
     LEFT JOIN commerce.products p ON p.id = ts.product_id
     WHERE ts.id IN (SELECT tire_spec_id FROM commerce.vehicle_fitments WHERE vehicle_model_id = $1);`,
    [NMAX_ID],
  );
  console.log('Tire specs + product env:');
  for (const r of ts.rows) console.log(' ', r);
  console.log();

  // 4. Existe current_prices?
  const cp = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'commerce' AND (table_name LIKE '%price%' OR table_name LIKE '%stock%');`,
  );
  console.log('Tabelas/views price/stock em commerce:');
  for (const r of cp.rows) console.log(' ', r.table_name);
  console.log();

  // 5. Preços dos produtos NMAX
  const prods = ts.rows.map((r) => r.product_id).filter(Boolean);
  if (prods.length > 0) {
    const pr = await client.query(
      `SELECT product_id, environment, price_amount, price_type, valid_from
       FROM commerce.product_prices
       WHERE product_id = ANY($1::uuid[])
       ORDER BY valid_from DESC NULLS LAST;`,
      [prods],
    );
    console.log(`Product_prices pros produtos NMAX (${pr.rows.length}):`);
    for (const r of pr.rows) console.log(' ', r);
    console.log();

    const sl = await client.query(
      `SELECT product_id, environment, quantity_available
       FROM commerce.stock_levels
       WHERE product_id = ANY($1::uuid[]);`,
      [prods],
    );
    console.log(`Stock_levels pros produtos NMAX (${sl.rows.length}):`);
    for (const r of sl.rows) console.log(' ', r);
    console.log();
  }

  // 6. Definição atual da função find_compatible_tires
  const fn = await client.query(
    `SELECT pg_get_functiondef(oid) AS def
     FROM pg_proc
     WHERE proname = 'find_compatible_tires';`,
  );
  console.log('Definição atual de find_compatible_tires:');
  console.log(fn.rows[0]?.def?.substring(0, 1500));

  await client.end();
}

main().catch((err) => { console.error('Erro:', err.message); process.exit(1); });
