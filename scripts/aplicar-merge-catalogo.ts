/**
 * Limpa prod (catalogo sintetico antigo) e promove test -> prod.
 * Adiciona aliases, precos ficticios, estoque ficticio, e delivery_zone de Bangu.
 *
 * Uso:
 *   DRY-RUN  (padrao):  npx tsx --env-file=.env scripts/aplicar-merge-catalogo.ts
 *   COMMIT  : COMMIT=1  npx tsx --env-file=.env scripts/aplicar-merge-catalogo.ts
 *
 * Tudo numa transacao. Em dry-run, faz ROLLBACK no fim.
 */
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL ausente'); process.exit(1); }

const COMMIT = process.env.COMMIT === '1';

const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function count(label: string, sql: string) {
  const r = await client.query(sql);
  console.log(`  ${label.padEnd(40)} ${JSON.stringify(r.rows)}`);
}

async function main() {
  await client.connect();

  console.log(`=== MERGE CATALOGO test -> prod (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  await client.query('BEGIN');

  try {
    console.log('-- Antes --');
    await count('products by env', `SELECT environment, COUNT(*) FROM commerce.products GROUP BY environment ORDER BY environment;`);
    await count('vehicle_models by env', `SELECT environment, COUNT(*) FROM commerce.vehicle_models GROUP BY environment ORDER BY environment;`);
    await count('vehicle_fitments by env', `SELECT environment, COUNT(*) FROM commerce.vehicle_fitments GROUP BY environment ORDER BY environment;`);
    await count('product_prices by env', `SELECT environment, COUNT(*) FROM commerce.product_prices GROUP BY environment ORDER BY environment;`);
    await count('stock_levels by env', `SELECT environment, COUNT(*) FROM commerce.stock_levels GROUP BY environment ORDER BY environment;`);
    console.log();

    // ===========================================================
    // ETAPA A — limpar prod
    // ===========================================================
    console.log('ETAPA A — limpar prod');
    const a1 = await client.query(`DELETE FROM commerce.order_items WHERE environment='prod';`);
    console.log(`  A.1 DELETE order_items: ${a1.rowCount}`);
    const a2 = await client.query(`DELETE FROM commerce.orders WHERE environment='prod';`);
    console.log(`  A.2 DELETE orders: ${a2.rowCount}`);
    const a3 = await client.query(`DELETE FROM commerce.product_prices WHERE environment='prod';`);
    console.log(`  A.3 DELETE product_prices: ${a3.rowCount}`);
    const a4 = await client.query(`DELETE FROM commerce.stock_levels WHERE environment='prod';`);
    console.log(`  A.4 DELETE stock_levels: ${a4.rowCount}`);
    const a5 = await client.query(`DELETE FROM commerce.fitment_discoveries WHERE environment IN ('prod','test');`);
    console.log(`  A.5 DELETE fitment_discoveries (prod+test): ${a5.rowCount}`);
    const a6 = await client.query(`DELETE FROM commerce.products WHERE environment='prod';`);
    console.log(`  A.6 DELETE products (cascateia tire_specs + fitments): ${a6.rowCount}`);
    const a7 = await client.query(`DELETE FROM commerce.vehicle_models WHERE environment='prod';`);
    console.log(`  A.7 DELETE vehicle_models: ${a7.rowCount}`);
    console.log();

    // ===========================================================
    // ETAPA B — reinserir test -> prod (environment é imutável, então
    // não dá UPDATE; copiamos com novos UUIDs e apagamos os originais).
    // ===========================================================
    console.log('ETAPA B — reinserir test -> prod');

    // B.0 — mapeamentos
    await client.query(`
      CREATE TEMP TABLE vm_remap ON COMMIT DROP AS
      SELECT id AS old_id, gen_random_uuid() AS new_id
      FROM commerce.vehicle_models WHERE environment='test';
    `);
    await client.query(`
      CREATE TEMP TABLE p_remap ON COMMIT DROP AS
      SELECT id AS old_id, gen_random_uuid() AS new_id
      FROM commerce.products WHERE environment='test';
    `);
    await client.query(`
      CREATE TEMP TABLE ts_remap ON COMMIT DROP AS
      SELECT id AS old_id, gen_random_uuid() AS new_id
      FROM commerce.tire_specs WHERE environment='test';
    `);

    const b1 = await client.query(`
      INSERT INTO commerce.vehicle_models (
        id, environment, vehicle_type, make, model, variant,
        year_start, year_end, displacement_cc, segment, aliases
      )
      SELECT vmr.new_id, 'prod', vm.vehicle_type, vm.make, vm.model, vm.variant,
             vm.year_start, vm.year_end, vm.displacement_cc, vm.segment, vm.aliases
      FROM commerce.vehicle_models vm
      JOIN vm_remap vmr ON vmr.old_id = vm.id
      WHERE vm.environment='test';
    `);
    console.log(`  B.1 INSERT vehicle_models em prod: ${b1.rowCount}`);

    const b2 = await client.query(`
      INSERT INTO commerce.products (
        id, environment, product_code, product_name, product_type,
        brand, short_description, internal_notes
      )
      SELECT pr.new_id, 'prod', p.product_code, p.product_name, p.product_type,
             p.brand, p.short_description, p.internal_notes
      FROM commerce.products p
      JOIN p_remap pr ON pr.old_id = p.id
      WHERE p.environment='test';
    `);
    console.log(`  B.2 INSERT products em prod: ${b2.rowCount}`);

    const b3 = await client.query(`
      INSERT INTO commerce.tire_specs (
        id, environment, product_id, tire_size,
        width_mm, aspect_ratio, rim_diameter, load_index, speed_rating,
        construction, tread_pattern, intended_use, "position"
      )
      SELECT tr.new_id, 'prod', pr.new_id, ts.tire_size,
             ts.width_mm, ts.aspect_ratio, ts.rim_diameter, ts.load_index, ts.speed_rating,
             ts.construction, ts.tread_pattern, ts.intended_use, ts."position"
      FROM commerce.tire_specs ts
      JOIN ts_remap tr ON tr.old_id = ts.id
      JOIN p_remap pr ON pr.old_id = ts.product_id
      WHERE ts.environment='test';
    `);
    console.log(`  B.3 INSERT tire_specs em prod: ${b3.rowCount}`);

    const b4 = await client.query(`
      INSERT INTO commerce.vehicle_fitments (
        id, environment, vehicle_model_id, tire_spec_id, "position",
        is_oem, source, confidence_level
      )
      SELECT gen_random_uuid(), 'prod', vmr.new_id, tr.new_id, vf."position",
             vf.is_oem, vf.source, vf.confidence_level
      FROM commerce.vehicle_fitments vf
      JOIN vm_remap vmr ON vmr.old_id = vf.vehicle_model_id
      JOIN ts_remap tr ON tr.old_id = vf.tire_spec_id
      WHERE vf.environment='test';
    `);
    console.log(`  B.4 INSERT vehicle_fitments em prod: ${b4.rowCount}`);

    // B.5 — apagar originais de test (cascateia tire_specs + fitments)
    const b5a = await client.query(`DELETE FROM commerce.products WHERE environment='test';`);
    console.log(`  B.5 DELETE products em test (cascateia): ${b5a.rowCount}`);
    const b5b = await client.query(`DELETE FROM commerce.vehicle_models WHERE environment='test';`);
    console.log(`  B.6 DELETE vehicle_models em test: ${b5b.rowCount}`);
    console.log();

    // ===========================================================
    // ETAPA C — aliases nos modelos populares
    // ===========================================================
    console.log('ETAPA C — aliases populares');
    const aliasMap: Array<[string, string[]]> = [
      ['NMAX',           ['NMAX', 'nmax', 'N-MAX', 'n-max']],
      ['Biz',            ['Biz', 'biz', 'Bis', 'bis']],
      ['PCX',            ['PCX', 'pcx', 'P CX', 'p cx']],
      ['Pop',            ['Pop', 'pop', 'Pop 100', 'Pop 110']],
      ['Factor',         ['Factor', 'factor', 'YBR Factor', 'ybr factor']],
      ['Fazer',          ['Fazer', 'fazer', 'YS Fazer']],
      ['NXR',            ['Bros', 'bros', 'NXR Bros']],
      ['XRE',            ['XRE', 'xre', 'X RE']],
      ['XTZ',            ['XTZ', 'xtz', 'Crosser', 'crosser', 'Lander', 'lander', 'Tenere', 'tenere', 'Ténéré', 'ténéré']],
      ['CG ',            ['CG', 'cg', 'Titan', 'titan', 'Fan', 'fan', 'Cargo', 'cargo', 'Start', 'start']],
      ['CB ',            ['CB', 'cb']],
      ['MT-',            ['MT', 'mt']],
      ['Burgman',        ['Burgman', 'burgman']],
      ['Tenere',         ['Tenere', 'tenere', 'Ténéré', 'ténéré', 'XT660']],
      ['Ténéré',         ['Tenere', 'tenere', 'Ténéré', 'ténéré', 'XT660']],
      ['Hornet',         ['Hornet', 'hornet', 'CB 600F']],
      ['Africa Twin',    ['Africa Twin', 'africa twin', 'CRF 1000', 'CRF 1100']],
      ['Falcon',         ['Falcon', 'falcon', 'NX 400']],
      ['Neo',            ['Neo', 'neo', 'Neo 125']],
      ['CRF',            ['CRF', 'crf']],
      ['Dominar',        ['Dominar', 'dominar']],
      ['Lander',         ['Lander', 'lander', 'XTZ 250 Lander']],
      ['Crosser',        ['Crosser', 'crosser', 'XTZ 150 Crosser']],
    ];
    for (const [needle, aliases] of aliasMap) {
      const r = await client.query(
        `UPDATE commerce.vehicle_models
         SET aliases = (
           SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(aliases, ARRAY[]::text[]) || $1::text[]))
         )
         WHERE environment='prod' AND deleted_at IS NULL AND model ILIKE $2;`,
        [aliases, '%' + needle + '%'],
      );
      console.log(`  C.${needle.padEnd(15)} modelos atualizados: ${r.rowCount}`);
    }
    console.log();

    // ===========================================================
    // ETAPA D — preco unico R$ 99 pra todos os produtos
    // ===========================================================
    console.log('ETAPA D — preco unico R$ 99');
    const d = await client.query(`
      INSERT INTO commerce.product_prices (environment, product_id, price_amount, currency, price_type, valid_from)
      SELECT 'prod', p.id, 99.00, 'BRL', 'regular', now()
      FROM commerce.products p
      WHERE p.environment='prod' AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM commerce.product_prices pp
          WHERE pp.product_id = p.id AND pp.environment='prod'
        );
    `);
    console.log(`  D INSERT product_prices: ${d.rowCount}`);
    console.log();

    // ===========================================================
    // ETAPA E — estoque ficticio (10 unidades por produto)
    // ===========================================================
    console.log('ETAPA E — estoque ficticio');
    const e = await client.query(`
      INSERT INTO commerce.stock_levels (environment, product_id, quantity_available, location)
      SELECT 'prod', p.id, 10, 'main'
      FROM commerce.products p
      WHERE p.environment='prod' AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM commerce.stock_levels sl
          WHERE sl.product_id = p.id AND sl.environment='prod' AND sl.location='main'
        );
    `);
    console.log(`  E INSERT stock_levels: ${e.rowCount}`);
    console.log();

    // ===========================================================
    // ETAPA F — frete 9.90 em todas as regioes (UPDATE existentes + INSERT faltantes)
    // ===========================================================
    console.log('ETAPA F — frete uniforme R$ 9,90 em todas as regioes');
    const f1 = await client.query(`
      UPDATE commerce.delivery_zones
      SET delivery_fee = 9.90,
          delivery_days = 1,
          is_available = true,
          updated_at = now()
      WHERE environment='prod';
    `);
    console.log(`  F.1 UPDATE delivery_zones existentes -> 9.90: ${f1.rowCount}`);

    const f2 = await client.query(`
      INSERT INTO commerce.delivery_zones (environment, geo_resolution_id, delivery_fee, delivery_days, delivery_mode, is_available)
      SELECT 'prod', gr.id, 9.90, 1, 'own_fleet', true
      FROM commerce.geo_resolutions gr
      WHERE gr.environment='prod'
        AND NOT EXISTS (
          SELECT 1 FROM commerce.delivery_zones dz
          WHERE dz.geo_resolution_id = gr.id AND dz.environment='prod' AND dz.delivery_mode='own_fleet'
        );
    `);
    console.log(`  F.2 INSERT delivery_zones faltantes: ${f2.rowCount}`);
    console.log();

    // ===========================================================
    // Verificacao final
    // ===========================================================
    console.log('-- Depois --');
    await count('products by env', `SELECT environment, COUNT(*) FROM commerce.products GROUP BY environment ORDER BY environment;`);
    await count('vehicle_models by env', `SELECT environment, COUNT(*) FROM commerce.vehicle_models GROUP BY environment ORDER BY environment;`);
    await count('vehicle_fitments by env', `SELECT environment, COUNT(*) FROM commerce.vehicle_fitments GROUP BY environment ORDER BY environment;`);
    await count('product_prices by env', `SELECT environment, COUNT(*) FROM commerce.product_prices GROUP BY environment ORDER BY environment;`);
    await count('stock_levels by env', `SELECT environment, COUNT(*) FROM commerce.stock_levels GROUP BY environment ORDER BY environment;`);
    console.log();

    // teste: NMAX agora resolve?
    console.log('-- Smoke test NMAX --');
    const sm1 = await client.query(`SELECT * FROM commerce.resolve_vehicle_model('prod'::env_t, 'NMAX', NULL, 0.3);`);
    console.log(`  resolve_vehicle_model('NMAX'): ${sm1.rows.length}`);
    for (const r of sm1.rows) console.log(`    ${r.make} ${r.model} | ${r.match_type} sim=${r.match_similarity}`);

    const nmaxRow = await client.query(`SELECT id FROM commerce.vehicle_models WHERE environment='prod' AND model ILIKE '%NMAX%' LIMIT 1;`);
    if (nmaxRow.rows.length > 0) {
      const compat = await client.query(`SELECT * FROM commerce.find_compatible_tires('prod'::env_t, $1, 'rear');`, [nmaxRow.rows[0].id]);
      console.log(`  find_compatible_tires(NMAX, rear): ${compat.rows.length}`);
      for (const r of compat.rows) console.log(`    ${r.product_name} | ${r.tire_size} | preco=${r.current_price} | estoque=${r.total_stock}`);
    }

    // teste: cobertura de frete e Bangu
    console.log('\n-- Smoke test frete --');
    const bg = await client.query(`
      SELECT dz.delivery_fee, dz.delivery_days, dz.delivery_mode, dz.is_available, gr.neighborhood_canonical
      FROM commerce.delivery_zones dz
      JOIN commerce.geo_resolutions gr ON gr.id = dz.geo_resolution_id
      WHERE dz.environment='prod' AND lower(gr.neighborhood_canonical) = 'bangu';
    `);
    for (const r of bg.rows) console.log(`  Bangu: R$${r.delivery_fee} | ${r.delivery_days}d | ${r.delivery_mode}`);

    const coverage = await client.query(`
      SELECT COUNT(*) AS total_geo,
             (SELECT COUNT(*) FROM commerce.delivery_zones WHERE environment='prod') AS total_zones,
             (SELECT COUNT(DISTINCT delivery_fee) FROM commerce.delivery_zones WHERE environment='prod') AS distinct_fees,
             (SELECT MIN(delivery_fee) FROM commerce.delivery_zones WHERE environment='prod') AS min_fee,
             (SELECT MAX(delivery_fee) FROM commerce.delivery_zones WHERE environment='prod') AS max_fee
      FROM commerce.geo_resolutions WHERE environment='prod';
    `);
    const cov = coverage.rows[0];
    console.log(`  cobertura: ${cov.total_zones}/${cov.total_geo} regioes com zone | fee min/max: R$${cov.min_fee}/R$${cov.max_fee} | distincts=${cov.distinct_fees}`);

    if (COMMIT) {
      await client.query('COMMIT');
      console.log('\n*** COMMIT efetuado. Mudanças persistidas. ***');
    } else {
      await client.query('ROLLBACK');
      console.log('\n*** DRY-RUN: ROLLBACK efetuado. Nada foi salvo. Rode com COMMIT=1 para aplicar. ***');
    }
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('\nErro durante merge — ROLLBACK efetuado:', err.message);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch(() => process.exit(1));
