'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  console.log('=== PCX em vehicle_models ===');
  const models = await client.query(`
    SELECT id, make, model, variant, year_start, year_end, displacement_cc, aliases
    FROM commerce.vehicle_models
    WHERE environment='prod' AND deleted_at IS NULL
      AND lower(model) LIKE '%pcx%'
    ORDER BY year_start NULLS FIRST;
  `);
  for (const m of models.rows) {
    console.log(`  [${m.id}] ${m.make} ${m.model} ${m.variant ?? ''} | anos=${m.year_start ?? '?'}-${m.year_end ?? '?'} | ${m.displacement_cc ?? '?'}cc | aliases=${JSON.stringify(m.aliases)}`);
  }
  console.log();

  console.log('=== Fitments cadastrados pra cada PCX ===');
  for (const m of models.rows) {
    const fits = await client.query(`
      SELECT f.id, f.position, f.is_oem, f.confidence_level, ts.tire_size, p.product_name
      FROM commerce.vehicle_fitments f
      LEFT JOIN commerce.tire_specs ts ON ts.id = f.tire_spec_id
      LEFT JOIN commerce.products p ON p.id = ts.product_id
      WHERE f.environment='prod' AND f.vehicle_model_id = $1;
    `, [m.id]);
    console.log(`  ${m.model} ${m.variant ?? ''} (${m.year_start ?? '?'}-${m.year_end ?? '?'}): ${fits.rows.length} fitment(s)`);
    for (const f of fits.rows) {
      console.log(`    ${f.position}: ${f.tire_size ?? '-'} | ${f.product_name ?? '-'} | OEM=${f.is_oem} conf=${f.confidence_level}`);
    }
  }
  console.log();

  console.log('=== find_compatible_tires(PCX 160, *) ===');
  const pcx160 = models.rows.find((m) => m.model === 'PCX 160' || (m.year_end === 2026 && m.model.includes('PCX')));
  if (pcx160) {
    const compat = await client.query(`SELECT * FROM commerce.find_compatible_tires('prod'::env_t, $1, NULL);`, [pcx160.id]);
    console.log(`  ${compat.rows.length} resultado(s):`);
    for (const r of compat.rows) {
      console.log(`    ${r.tire_size} | ${r.fitment_position} | preco=${r.current_price} | estoque=${r.total_stock}`);
    }
  }

  console.log('\n=== resolve_vehicle_model(PCX, 2025) ===');
  const resolved = await client.query(`SELECT * FROM commerce.resolve_vehicle_model('prod'::env_t, 'PCX', 2025, 0.3);`);
  for (const r of resolved.rows) {
    console.log(`  ${r.make} ${r.model} ${r.variant ?? ''} | ${r.match_type} sim=${r.match_similarity} | id=${r.vehicle_model_id}`);
  }

  await client.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
