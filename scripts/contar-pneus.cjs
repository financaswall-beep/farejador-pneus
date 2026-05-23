'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  const total = await client.query(`
    SELECT COUNT(*)::int AS n
    FROM commerce.products
    WHERE environment='prod' AND product_type='tire' AND deleted_at IS NULL;
  `);
  console.log(`Pneus cadastrados em prod: ${total.rows[0].n}`);

  const breakdown = await client.query(`
    SELECT CASE
             WHEN p.product_name ILIKE '%scooter%' THEN 'scooter'
             WHEN p.product_name ILIKE '%moto%'   THEN 'moto'
             ELSE 'outro'
           END AS categoria,
           COUNT(*)::int AS n
    FROM commerce.products p
    WHERE p.environment='prod' AND p.product_type='tire' AND p.deleted_at IS NULL
    GROUP BY 1
    ORDER BY n DESC;
  `);
  console.log('\nPor categoria:');
  for (const r of breakdown.rows) console.log(`  ${r.categoria}: ${r.n}`);

  const byPos = await client.query(`
    SELECT ts."position" AS pos, COUNT(*)::int AS n
    FROM commerce.tire_specs ts
    WHERE ts.environment='prod'
    GROUP BY ts."position"
    ORDER BY n DESC;
  `);
  console.log('\nPor posicao (tire_specs):');
  for (const r of byPos.rows) console.log(`  ${r.pos ?? 'sem posicao'}: ${r.n}`);

  const fitments = await client.query(`SELECT COUNT(*)::int AS n FROM commerce.vehicle_fitments WHERE environment='prod';`);
  const models   = await client.query(`SELECT COUNT(*)::int AS n FROM commerce.vehicle_models   WHERE environment='prod' AND deleted_at IS NULL;`);
  const prices   = await client.query(`SELECT COUNT(*)::int AS n FROM commerce.product_prices   WHERE environment='prod';`);
  const stock    = await client.query(`SELECT COUNT(*)::int AS n FROM commerce.stock_levels     WHERE environment='prod';`);

  console.log('\nResumo do catalogo em prod:');
  console.log(`  modelos de moto:        ${models.rows[0].n}`);
  console.log(`  fitments (compat):      ${fitments.rows[0].n}`);
  console.log(`  pneus com preco:        ${prices.rows[0].n}`);
  console.log(`  pneus com estoque:      ${stock.rows[0].n}`);

  await client.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
