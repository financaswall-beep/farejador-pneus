'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  // Modelos "genericos" = sem year_start nem year_end nem variant
  console.log('=== MODELOS GENERICOS (sem ano + sem variant) e quantos fitments ===');
  const genericos = await client.query(`
    SELECT vm.id, vm.make, vm.model, vm.variant, vm.year_start, vm.year_end, vm.displacement_cc,
           (SELECT COUNT(*) FROM commerce.vehicle_fitments f WHERE f.vehicle_model_id = vm.id AND f.environment='prod') AS fitments_count
    FROM commerce.vehicle_models vm
    WHERE vm.environment='prod' AND vm.deleted_at IS NULL
      AND vm.year_start IS NULL AND vm.year_end IS NULL AND vm.variant IS NULL
    ORDER BY vm.make, vm.model;
  `);
  for (const r of genericos.rows) {
    console.log(`  ${r.make} ${r.model} | fitments=${r.fitments_count}`);
  }
  console.log(`\n  TOTAL genericos sem fitment: ${genericos.rows.filter((r) => Number(r.fitments_count) === 0).length}`);
  console.log(`  TOTAL genericos COM fitment: ${genericos.rows.filter((r) => Number(r.fitments_count) > 0).length}`);
  console.log();

  // Quais genericos tem duplicado especifico com fitment
  console.log('=== GENERICOS QUE TEM DUPLICATA ESPECIFICA COM FITMENT ===');
  const duplicados = await client.query(`
    SELECT g.id AS generic_id, g.make, g.model AS generic_model,
           array_agg(DISTINCT s.model || COALESCE(' ' || s.variant, '') || ' (' || COALESCE(s.year_start::text, '?') || '-' || COALESCE(s.year_end::text, '?') || ')') FILTER (WHERE s.id IS NOT NULL) AS variants_with_fitment
    FROM commerce.vehicle_models g
    LEFT JOIN commerce.vehicle_models s ON s.make = g.make
                                       AND s.environment='prod'
                                       AND s.deleted_at IS NULL
                                       AND (s.model LIKE g.model || ' %' OR s.model = g.model OR g.aliases && s.aliases)
                                       AND s.id != g.id
                                       AND EXISTS (SELECT 1 FROM commerce.vehicle_fitments f WHERE f.vehicle_model_id = s.id AND f.environment='prod')
    WHERE g.environment='prod' AND g.deleted_at IS NULL
      AND g.year_start IS NULL AND g.year_end IS NULL AND g.variant IS NULL
      AND NOT EXISTS (SELECT 1 FROM commerce.vehicle_fitments f WHERE f.vehicle_model_id = g.id AND f.environment='prod')
    GROUP BY g.id, g.make, g.model
    HAVING COUNT(s.id) > 0
    ORDER BY g.make, g.model;
  `);
  for (const r of duplicados.rows) {
    console.log(`  ${r.make} ${r.generic_model} → variantes uteis: ${(r.variants_with_fitment || []).join(' | ')}`);
  }
  console.log(`\n  TOTAL: ${duplicados.rows.length} entradas genericas SEM fitment QUE tem alternativa especifica COM fitment`);

  await client.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
