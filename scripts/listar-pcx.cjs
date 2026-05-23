'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  // 1. Modelos PCX cadastrados
  console.log('=== MODELOS PCX em prod ===');
  const models = await client.query(`
    SELECT id, make, model, variant, year_start, year_end, displacement_cc, aliases
    FROM commerce.vehicle_models
    WHERE environment='prod' AND deleted_at IS NULL
      AND (lower(model) LIKE '%pcx%' OR 'pcx' = ANY(SELECT lower(unnest(aliases))))
    ORDER BY year_start NULLS FIRST;
  `);
  for (const m of models.rows) {
    console.log(`  ${m.make} ${m.model}${m.variant ? ' ' + m.variant : ''} | anos=${m.year_start ?? '?'}-${m.year_end ?? '?'} | ${m.displacement_cc ?? '?'}cc`);
    console.log(`    aliases: ${JSON.stringify(m.aliases)}`);
  }
  console.log();

  // 2. Pra cada modelo, fitments
  console.log('=== FITMENTS CADASTRADOS POR MODELO ===');
  for (const m of models.rows) {
    const fits = await client.query(`
      SELECT f.position, f.is_oem, f.confidence_level,
             ts.tire_size, ts.construction, ts.width_mm, ts.aspect_ratio, ts.rim_diameter,
             p.product_name, p.product_code,
             pp.price_amount, pp.currency,
             sl.quantity_available
      FROM commerce.vehicle_fitments f
      JOIN commerce.tire_specs ts ON ts.id = f.tire_spec_id
      JOIN commerce.products p ON p.id = ts.product_id AND p.deleted_at IS NULL
      LEFT JOIN commerce.product_prices pp ON pp.product_id = p.id AND pp.environment = p.environment
      LEFT JOIN commerce.stock_levels sl ON sl.product_id = p.id AND sl.environment = p.environment AND sl.location='main'
      WHERE f.environment='prod' AND f.vehicle_model_id = $1
      ORDER BY f.position, f.is_oem DESC;
    `, [m.id]);

    console.log(`\n  ${m.make} ${m.model}${m.variant ? ' ' + m.variant : ''} (${m.year_start ?? '?'}-${m.year_end ?? '?'}):`);
    if (fits.rows.length === 0) {
      console.log('    (sem fitment cadastrado)');
    } else {
      for (const f of fits.rows) {
        const posBR = f.position === 'front' ? 'DIANTEIRO' : f.position === 'rear' ? 'TRASEIRO' : 'AMBOS';
        console.log(`    ${posBR}: ${f.tire_size} (${f.construction ?? '-'}) | ${f.product_name}`);
        console.log(`      code=${f.product_code} | preco=${f.currency} ${f.price_amount ?? 'sem preco'} | estoque=${f.quantity_available ?? 0} un | OEM=${f.is_oem} conf=${f.confidence_level}`);
      }
    }
  }
  console.log();

  // 3. Simulação: o que o bot acharia se cliente perguntasse "PCX 2025"
  console.log('=== SIMULACAO: cliente diz "PCX 2025" ===');
  const sim2025 = await client.query(`
    SELECT model, variant, year_start, year_end, match_type, match_similarity
    FROM commerce.resolve_vehicle_model('prod'::env_t, 'PCX', 2025, 0.3)
    LIMIT 3;
  `);
  console.log('  resolve_vehicle_model(PCX, 2025):');
  for (const r of sim2025.rows) {
    console.log(`    ${r.model}${r.variant ? ' ' + r.variant : ''} | anos=${r.year_start ?? '?'}-${r.year_end ?? '?'} | ${r.match_type} sim=${r.match_similarity}`);
  }

  console.log('\n  find_compatible_tires (mesmo id que o resolve retornaria — o de cima):');
  const pcxRow = await client.query(`
    SELECT vehicle_model_id FROM commerce.resolve_vehicle_model('prod'::env_t, 'PCX', 2025, 0.3) LIMIT 1;
  `);
  if (pcxRow.rows.length > 0) {
    const compat = await client.query(`SELECT * FROM commerce.find_compatible_tires('prod'::env_t, $1, NULL);`, [pcxRow.rows[0].vehicle_model_id]);
    for (const c of compat.rows) {
      console.log(`    ${c.tire_size} ${c.fitment_position} | ${c.product_name} | preco=R$${c.current_price} | estoque=${c.total_stock}`);
    }
  }

  console.log('\n=== SIMULACAO: cliente diz "PCX 2018" ===');
  const sim2018 = await client.query(`
    SELECT model, variant, year_start, year_end, match_type, match_similarity
    FROM commerce.resolve_vehicle_model('prod'::env_t, 'PCX', 2018, 0.3)
    LIMIT 3;
  `);
  for (const r of sim2018.rows) {
    console.log(`  ${r.model}${r.variant ? ' ' + r.variant : ''} | anos=${r.year_start ?? '?'}-${r.year_end ?? '?'} | ${r.match_type} sim=${r.match_similarity}`);
  }

  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
