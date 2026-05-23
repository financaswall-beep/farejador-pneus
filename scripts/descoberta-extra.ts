import { Client } from 'pg';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL ausente'); process.exit(1); }
const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  console.log('=== Partner tables referenciando products em prod ===');
  for (const t of ['partner_stock_levels', 'partner_purchase_items']) {
    try {
      const r = await client.query(`SELECT environment, COUNT(*) AS n FROM commerce.${t} GROUP BY environment;`);
      console.log(`  ${t}:`);
      for (const row of r.rows) console.log(`    ${row.environment} = ${row.n}`);
    } catch (e: any) { console.log(`  ${t}: ${e.message}`); }
  }
  console.log();

  console.log('=== fitment_discoveries por env ===');
  const fd = await client.query(`SELECT environment, status, COUNT(*) FROM commerce.fitment_discoveries GROUP BY environment, status ORDER BY environment, status;`);
  for (const r of fd.rows) console.log(`  ${r.environment} ${r.status} = ${r.count}`);
  console.log();

  console.log('=== Bangu em geo_resolutions (prod) ===');
  const bangu = await client.query(
    `SELECT id, neighborhood_canonical, city_name, state_code, aliases
     FROM commerce.geo_resolutions
     WHERE environment='prod' AND lower(neighborhood_canonical) LIKE '%bangu%';`,
  );
  for (const r of bangu.rows) console.log(`  ${r.neighborhood_canonical} | ${r.city_name}/${r.state_code} | aliases=${JSON.stringify(r.aliases)}`);
  console.log();

  console.log('=== Bangu em delivery_zones (prod) ===');
  const bz = await client.query(
    `SELECT dz.delivery_fee, dz.delivery_days, dz.delivery_mode, dz.is_available, gr.neighborhood_canonical
     FROM commerce.delivery_zones dz
     JOIN commerce.geo_resolutions gr ON gr.id = dz.geo_resolution_id
     WHERE dz.environment='prod' AND lower(gr.neighborhood_canonical) LIKE '%bangu%';`,
  );
  for (const r of bz.rows) console.log(`  ${r.neighborhood_canonical} | R$${r.delivery_fee} | ${r.delivery_days}d | ${r.delivery_mode} | disponível=${r.is_available}`);
  if (bz.rows.length === 0) console.log('  (nenhuma zona pra bangu)');
  console.log();

  console.log('=== Tire sizes em test (catalogo a promover) ===');
  const sizes = await client.query(
    `SELECT DISTINCT ts.tire_size, p.product_name
     FROM commerce.tire_specs ts
     JOIN commerce.products p ON p.id = ts.product_id
     WHERE ts.environment='test'
     ORDER BY ts.tire_size;`,
  );
  for (const r of sizes.rows) console.log(`  ${r.tire_size} → ${r.product_name}`);
  console.log();

  console.log('=== TODOS modelos populares em test (top scooter/commuter) ===');
  const top = await client.query(
    `SELECT DISTINCT make, model, variant, year_start, year_end
     FROM commerce.vehicle_models
     WHERE environment='test'
       AND (model ~* 'nmax|biz|pop|cg|titan|fan|factor|ybr|cb 300|cb 500|xre|ténéré|tenere|fazer|next|broz|burgman|pcx|sh\\s*150|adv\\s*150|mt-03|mt-07|mt-09|cb 650|cbr|hornet|xj6|tracer|xt 660|crf|xtz|nx|lander|crypton|neo')
     ORDER BY make, model;`,
  );
  for (const r of top.rows) console.log(`  ${r.make} ${r.model} ${r.variant ?? ''} (${r.year_start}-${r.year_end})`);

  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
