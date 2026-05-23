/**
 * Olha o que existe pra NMAX no commerce: vehicle_model, fitments, products, prices, stock.
 * Apenas SELECT.
 */

import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[ERRO] DATABASE_URL ausente.');
  process.exit(1);
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();

  console.log('=== CHECAGEM NMAX NO COMMERCE ===\n');

  // 1. Modelo
  const models = await client.query(
    `SELECT id, make, model, variant, year_start, year_end, displacement_cc, aliases
     FROM commerce.vehicle_models
     WHERE deleted_at IS NULL
       AND (lower(model) LIKE '%nmax%'
            OR lower(make || ' ' || model) LIKE '%nmax%'
            OR 'nmax' = ANY(SELECT lower(unnest(aliases))));`,
  );

  console.log(`--- VEHICLE_MODELS (${models.rows.length}) ---`);
  for (const m of models.rows) {
    console.log(`  [${m.id}] ${m.make} ${m.model}${m.variant ? ' ' + m.variant : ''} | ${m.year_start ?? '?'}-${m.year_end ?? '?'} | ${m.displacement_cc}cc | aliases=${JSON.stringify(m.aliases)}`);
  }
  console.log('');

  if (models.rows.length === 0) {
    console.log('** NENHUM modelo NMAX cadastrado em commerce.vehicle_models **');
    await client.end();
    return;
  }

  // 2. Fitments por modelo
  for (const m of models.rows) {
    const fitments = await client.query(
      `SELECT f.id, f.position, f.is_oem, f.source, f.confidence_level,
              ts.tire_size, p.id AS product_id, p.product_name, p.brand
       FROM commerce.vehicle_fitments f
       LEFT JOIN commerce.tire_specs ts ON ts.id = f.tire_spec_id
       LEFT JOIN commerce.products p ON p.id = ts.product_id AND p.deleted_at IS NULL
       WHERE f.vehicle_model_id = $1
       ORDER BY f.position, f.is_oem DESC;`,
      [m.id],
    );

    console.log(`--- FITMENTS pra ${m.make} ${m.model} (${m.id}) — total ${fitments.rows.length} ---`);
    for (const f of fitments.rows) {
      console.log(`  pos=${f.position} oem=${f.is_oem} conf=${f.confidence_level} size=${f.tire_size ?? '-'} produto=${f.product_name ?? '-'} (${f.brand ?? '-'})`);
    }
    console.log('');
  }

  // 3. Tire specs com medidas 90/90-18, 130/70-13, 110/70-13 (medidas comuns NMAX)
  const sizes = await client.query(
    `SELECT ts.id, ts.tire_size, ts.product_id, p.product_name, p.brand
     FROM commerce.tire_specs ts
     LEFT JOIN commerce.products p ON p.id = ts.product_id
     WHERE ts.tire_size IN ('130/70-13', '110/70-13', '120/70-13', '140/70-13')
     ORDER BY ts.tire_size;`,
  );

  console.log(`--- TIRE_SPECS em medidas tipicas NMAX (${sizes.rows.length}) ---`);
  for (const s of sizes.rows) {
    console.log(`  ${s.tire_size} | produto=${s.product_name ?? '-'} (${s.brand ?? '-'})`);
  }
  console.log('');

  // 4. Tenta resolver pelo nome via resolve_vehicle_model
  const resolved = await client.query(
    `SELECT * FROM commerce.resolve_vehicle_model('prod'::env_t, 'NMAX', NULL, 0.4);`,
  );
  console.log(`--- resolve_vehicle_model('NMAX') (${resolved.rows.length}) ---`);
  for (const r of resolved.rows) {
    console.log(`  [${r.vehicle_model_id}] ${r.make} ${r.model} ${r.variant ?? ''} | ${r.match_type} sim=${r.match_similarity}`);
  }
  console.log('');

  // 5. find_compatible_tires por modelo + posicao
  for (const m of models.rows) {
    const compat = await client.query(
      `SELECT * FROM commerce.find_compatible_tires('prod'::env_t, $1, 'rear');`,
      [m.id],
    );
    console.log(`--- find_compatible_tires(${m.model}, rear) — ${compat.rows.length} ---`);
    for (const c of compat.rows) {
      console.log(`  ${c.product_name} (${c.brand}) | ${c.tire_size} | preço=${c.current_price} | estoque=${c.total_stock} | conf=${c.confidence_level}`);
    }

    const compatF = await client.query(
      `SELECT * FROM commerce.find_compatible_tires('prod'::env_t, $1, 'front');`,
      [m.id],
    );
    console.log(`--- find_compatible_tires(${m.model}, front) — ${compatF.rows.length} ---`);
    for (const c of compatF.rows) {
      console.log(`  ${c.product_name} (${c.brand}) | ${c.tire_size} | preço=${c.current_price} | estoque=${c.total_stock} | conf=${c.confidence_level}`);
    }
    console.log('');
  }

  await client.end();
  console.log('=== FIM ===');
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
