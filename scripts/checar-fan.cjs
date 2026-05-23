'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  console.log('Busca por "fan" em vehicle_models (env=prod):');
  const r1 = await client.query(
    `SELECT id, make, model, variant, year_start, year_end, displacement_cc, aliases
     FROM commerce.vehicle_models
     WHERE environment='prod' AND deleted_at IS NULL
       AND (
         lower(model)   LIKE '%fan%'
         OR lower(variant) LIKE '%fan%'
         OR 'fan' = ANY(SELECT lower(unnest(aliases)))
         OR lower(make || ' ' || model) LIKE '%fan%'
       )
     ORDER BY make, model;`,
  );
  for (const r of r1.rows) {
    console.log(`  [${r.id}] ${r.make} ${r.model} ${r.variant ?? ''} (${r.year_start}-${r.year_end}) cc=${r.displacement_cc} aliases=${JSON.stringify(r.aliases)}`);
  }
  if (r1.rows.length === 0) console.log('  (nenhum modelo bate em fan)');

  console.log('\nBusca por "CG" (Honda CG 150/160 normalmente é Fan/Titan):');
  const r2 = await client.query(
    `SELECT id, make, model, variant, year_start, year_end, aliases
     FROM commerce.vehicle_models
     WHERE environment='prod' AND deleted_at IS NULL AND lower(model) LIKE '%cg%'
     ORDER BY model;`,
  );
  for (const r of r2.rows) console.log(`  [${r.id}] ${r.make} ${r.model} ${r.variant ?? ''} aliases=${JSON.stringify(r.aliases)}`);
  if (r2.rows.length === 0) console.log('  (nenhum CG)');

  console.log('\nrodando resolve_vehicle_model(Fan):');
  const r3 = await client.query(`SELECT * FROM commerce.resolve_vehicle_model('prod'::env_t, 'Fan', NULL, 0.3);`);
  for (const r of r3.rows) console.log(`  ${r.make} ${r.model} | ${r.match_type} sim=${r.match_similarity}`);
  if (r3.rows.length === 0) console.log('  (zero matches)');

  await client.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
