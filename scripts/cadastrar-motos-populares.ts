/**
 * Cadastra catalogo de motos populares brasileiras que estavam faltando.
 * Honda CG (150/160 — Fan/Titan/Start/Cargo)
 * Yamaha Factor (YBR 125, YBR 150)
 * Yamaha Fazer 150 / Fazer 250
 * Yamaha MT-03 / MT-07 / MT-09
 * Honda CB 300R, CB 500F/X, CB 650R, CB 1000R, Hornet, Twister
 *
 * Tambem cria medidas faltantes (80/100-18, 100/90-18, 110/70-17, 120/70-17,
 * 140/70-17, 190/55R17) com preco R$ 99 e estoque 10 — coerente com o catalogo
 * uniformizado.
 *
 * Tudo numa transacao. Dry-run por padrao.
 *
 * Uso:
 *   DRY-RUN: npx tsx --env-file=.env scripts/cadastrar-motos-populares.ts
 *   COMMIT:  COMMIT=1 npx tsx --env-file=.env scripts/cadastrar-motos-populares.ts
 */
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL ausente'); process.exit(1); }
const COMMIT = process.env.COMMIT === '1';
const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ----------------------------------------------------------------
// Medidas novas — adicionar como product (tire) + tire_spec + price + stock.
// Construcao: 'bias' (diagonal) por default, 'radial' onde mais usado.
// ----------------------------------------------------------------
const NEW_TIRES: Array<{
  productCode: string;
  productName: string;
  tireSize: string;
  position: 'front' | 'rear' | 'both';
  construction: 'radial' | 'bias' | null;
  widthMm: number;
  aspectRatio: number;
  rimDiameter: number;
}> = [
  { productCode: 'TIRE-80-100-18-FRONT-BIAS',  productName: 'Pneu Moto 80/100-18 Dianteiro Diagonal',  tireSize: '80/100-18',  position: 'front', construction: 'bias',   widthMm: 80,  aspectRatio: 100, rimDiameter: 18 },
  { productCode: 'TIRE-100-90-18-REAR-BIAS',   productName: 'Pneu Moto 100/90-18 Traseiro Diagonal',   tireSize: '100/90-18',  position: 'rear',  construction: 'bias',   widthMm: 100, aspectRatio: 90,  rimDiameter: 18 },
  { productCode: 'TIRE-110-70-17-FRONT-BIAS',  productName: 'Pneu Moto 110/70-17 Dianteiro Diagonal',  tireSize: '110/70-17',  position: 'front', construction: 'bias',   widthMm: 110, aspectRatio: 70,  rimDiameter: 17 },
  { productCode: 'TIRE-120-70-17-FRONT-RAD',   productName: 'Pneu Moto 120/70-17 Dianteiro Radial',    tireSize: '120/70R17',  position: 'front', construction: 'radial', widthMm: 120, aspectRatio: 70,  rimDiameter: 17 },
  { productCode: 'TIRE-140-70-17-REAR-BIAS',   productName: 'Pneu Moto 140/70-17 Traseiro Diagonal',   tireSize: '140/70-17',  position: 'rear',  construction: 'bias',   widthMm: 140, aspectRatio: 70,  rimDiameter: 17 },
  { productCode: 'TIRE-190-55-17-REAR-RAD',    productName: 'Pneu Moto 190/55R17 Traseiro Radial',     tireSize: '190/55R17',  position: 'rear',  construction: 'radial', widthMm: 190, aspectRatio: 55,  rimDiameter: 17 },
];

// ----------------------------------------------------------------
// Modelos novos — moto, model, variant, anos, cilindrada, aliases, fitments
// fitments referenciam tire_size (resolvido pra tire_spec_id no INSERT)
// ----------------------------------------------------------------
type FitmentSpec = { tireSize: string; position: 'front' | 'rear' | 'both' };
const NEW_MODELS: Array<{
  make: string;
  model: string;
  variant: string | null;
  yearStart: number | null;
  yearEnd: number | null;
  cc: number | null;
  aliases: string[];
  fitments: FitmentSpec[];
}> = [
  // ---- Honda CG ----
  { make: 'Honda', model: 'CG 150', variant: 'Fan',   yearStart: 2009, yearEnd: 2015, cc: 149,
    aliases: ['CG 150', 'cg 150', 'CG150', 'cg150', 'Fan', 'fan', 'CG Fan', 'CG 150 Fan', 'Honda Fan'],
    fitments: [{ tireSize: '80/100-18', position: 'front' }, { tireSize: '90/90-18', position: 'rear' }] },
  { make: 'Honda', model: 'CG 150', variant: 'Titan', yearStart: 2009, yearEnd: 2015, cc: 149,
    aliases: ['CG 150 Titan', 'Titan 150', 'titan 150', 'Titan', 'titan', 'CG Titan'],
    fitments: [{ tireSize: '80/100-18', position: 'front' }, { tireSize: '90/90-18', position: 'rear' }] },
  { make: 'Honda', model: 'CG 160', variant: 'Fan',   yearStart: 2015, yearEnd: 2026, cc: 162,
    aliases: ['CG 160', 'cg 160', 'CG160', 'cg160', 'Fan 160', 'CG 160 Fan', 'Honda CG 160 Fan'],
    fitments: [{ tireSize: '80/100-18', position: 'front' }, { tireSize: '100/90-18', position: 'rear' }] },
  { make: 'Honda', model: 'CG 160', variant: 'Titan', yearStart: 2015, yearEnd: 2026, cc: 162,
    aliases: ['CG 160 Titan', 'Titan 160', 'titan 160', 'CG Titan 160'],
    fitments: [{ tireSize: '80/100-18', position: 'front' }, { tireSize: '100/90-18', position: 'rear' }] },
  { make: 'Honda', model: 'CG 160', variant: 'Start', yearStart: 2015, yearEnd: 2026, cc: 162,
    aliases: ['CG 160 Start', 'Start', 'start', 'CG Start'],
    fitments: [{ tireSize: '80/100-18', position: 'front' }, { tireSize: '90/90-18', position: 'rear' }] },
  { make: 'Honda', model: 'CG 160', variant: 'Cargo', yearStart: 2015, yearEnd: 2026, cc: 162,
    aliases: ['CG 160 Cargo', 'Cargo', 'cargo', 'CG Cargo'],
    fitments: [{ tireSize: '80/100-18', position: 'front' }, { tireSize: '90/90-18', position: 'rear' }] },

  // ---- Yamaha Factor ----
  { make: 'Yamaha', model: 'Factor', variant: 'YBR 125', yearStart: 2009, yearEnd: 2016, cc: 125,
    aliases: ['Factor', 'factor', 'YBR 125', 'ybr 125', 'YBR125', 'Factor 125', 'YBR Factor 125', 'YBR Factor'],
    fitments: [{ tireSize: '2.75-18', position: 'front' }, { tireSize: '90/90-18', position: 'rear' }] },
  { make: 'Yamaha', model: 'Factor', variant: 'YBR 150', yearStart: 2016, yearEnd: 2026, cc: 149,
    aliases: ['Factor 150', 'factor 150', 'YBR 150', 'ybr 150', 'YBR150', 'YBR Factor 150'],
    fitments: [{ tireSize: '80/100-18', position: 'front' }, { tireSize: '90/90-18', position: 'rear' }] },

  // ---- Yamaha Fazer ----
  { make: 'Yamaha', model: 'Fazer 150', variant: null, yearStart: 2014, yearEnd: 2026, cc: 149,
    aliases: ['Fazer', 'fazer', 'Fazer 150', 'fazer 150', 'YS150', 'YS 150'],
    fitments: [{ tireSize: '80/100-18', position: 'front' }, { tireSize: '90/90-18', position: 'rear' }] },
  { make: 'Yamaha', model: 'Fazer 250', variant: null, yearStart: 2011, yearEnd: 2026, cc: 250,
    aliases: ['Fazer 250', 'fazer 250', 'YS250', 'YS 250'],
    fitments: [{ tireSize: '100/80-17', position: 'front' }, { tireSize: '130/70-17', position: 'rear' }] },

  // ---- Yamaha MT ----
  { make: 'Yamaha', model: 'MT-03', variant: null, yearStart: 2016, yearEnd: 2026, cc: 321,
    aliases: ['MT-03', 'mt-03', 'MT03', 'mt03', 'MT 03', 'mt 03'],
    fitments: [{ tireSize: '110/70-17', position: 'front' }, { tireSize: '140/70-17', position: 'rear' }] },
  { make: 'Yamaha', model: 'MT-07', variant: null, yearStart: 2018, yearEnd: 2026, cc: 689,
    aliases: ['MT-07', 'mt-07', 'MT07', 'mt07', 'MT 07', 'mt 07'],
    fitments: [{ tireSize: '120/70R17', position: 'front' }, { tireSize: '180/55R17', position: 'rear' }] },
  { make: 'Yamaha', model: 'MT-09', variant: null, yearStart: 2014, yearEnd: 2026, cc: 890,
    aliases: ['MT-09', 'mt-09', 'MT09', 'mt09', 'MT 09', 'mt 09'],
    fitments: [{ tireSize: '120/70R17', position: 'front' }, { tireSize: '180/55R17', position: 'rear' }] },

  // ---- Honda CB ----
  { make: 'Honda', model: 'CB 300R', variant: null, yearStart: 2018, yearEnd: 2026, cc: 286,
    aliases: ['CB 300', 'cb 300', 'CB300', 'cb300', 'CB 300R', 'CB 300F', 'CBR 300', 'Twister CB300'],
    fitments: [{ tireSize: '110/70-17', position: 'front' }, { tireSize: '140/70-17', position: 'rear' }] },
  { make: 'Honda', model: 'CB 500F', variant: null, yearStart: 2013, yearEnd: 2026, cc: 471,
    aliases: ['CB 500', 'cb 500', 'CB500', 'CB 500F', 'CB500F'],
    fitments: [{ tireSize: '120/70R17', position: 'front' }, { tireSize: '160/60R17', position: 'rear' }] },
  { make: 'Honda', model: 'CB 500X', variant: null, yearStart: 2013, yearEnd: 2026, cc: 471,
    aliases: ['CB 500X', 'CB500X', 'cb 500x'],
    fitments: [{ tireSize: '120/70R17', position: 'front' }, { tireSize: '160/60R17', position: 'rear' }] },
  { make: 'Honda', model: 'CB 650R', variant: null, yearStart: 2019, yearEnd: 2026, cc: 649,
    aliases: ['CB 650', 'cb 650', 'CB650', 'CB 650R', 'CB650R', 'CB 650F'],
    fitments: [{ tireSize: '120/70R17', position: 'front' }, { tireSize: '180/55R17', position: 'rear' }] },
  { make: 'Honda', model: 'CB 1000R', variant: null, yearStart: 2018, yearEnd: 2026, cc: 998,
    aliases: ['CB 1000R', 'CB1000R', 'cb 1000r', 'CB 1000', 'CB1000'],
    fitments: [{ tireSize: '120/70R17', position: 'front' }, { tireSize: '190/55R17', position: 'rear' }] },
  { make: 'Honda', model: 'Hornet', variant: 'CB 600F', yearStart: 2008, yearEnd: 2014, cc: 599,
    aliases: ['Hornet', 'hornet', 'CB 600', 'CB 600F', 'CB600F', 'cb600', 'CB 750 Hornet'],
    fitments: [{ tireSize: '120/70R17', position: 'front' }, { tireSize: '180/55R17', position: 'rear' }] },
  { make: 'Honda', model: 'Twister', variant: 'CBX 250', yearStart: 2001, yearEnd: 2008, cc: 249,
    aliases: ['Twister', 'twister', 'CBX 250', 'cbx 250', 'CBX250', 'CB 250 Twister'],
    fitments: [{ tireSize: '100/80-17', position: 'front' }, { tireSize: '130/70-17', position: 'rear' }] },
];

async function main() {
  await client.connect();
  await client.query('BEGIN');
  console.log(`=== CADASTRO MOTOS POPULARES (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  try {
    // ---------- ETAPA 1: criar tire_specs + products + price + stock pra cada medida nova ----------
    console.log('ETAPA 1 — Medidas novas');
    const tireSpecIdBySize = new Map<string, string>();

    // primeiro pega tire_specs ja existentes em prod
    const existing = await client.query(
      `SELECT id, tire_size, "position" FROM commerce.tire_specs WHERE environment='prod';`,
    );
    for (const row of existing.rows) {
      tireSpecIdBySize.set(`${row.tire_size}|${row.position}`, row.id);
    }
    console.log(`  ${existing.rows.length} tire_specs ja existem em prod`);

    let createdTires = 0;
    for (const t of NEW_TIRES) {
      const key = `${t.tireSize}|${t.position}`;
      if (tireSpecIdBySize.has(key)) {
        console.log(`  ${t.tireSize} ${t.position}: ja existe, pulando`);
        continue;
      }
      // Criar product
      const prodRes = await client.query(
        `INSERT INTO commerce.products (environment, product_code, product_name, product_type)
         VALUES ('prod', $1, $2, 'tire')
         RETURNING id;`,
        [t.productCode, t.productName],
      );
      const productId = prodRes.rows[0].id;

      // Criar tire_spec
      const tsRes = await client.query(
        `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter, construction, "position")
         VALUES ('prod', $1, $2, $3, $4, $5, $6, $7)
         RETURNING id;`,
        [productId, t.tireSize, t.widthMm, t.aspectRatio, t.rimDiameter, t.construction, t.position],
      );
      const tireSpecId = tsRes.rows[0].id;
      tireSpecIdBySize.set(key, tireSpecId);

      // Preco + estoque
      await client.query(
        `INSERT INTO commerce.product_prices (environment, product_id, price_amount, currency, price_type)
         VALUES ('prod', $1, 99.00, 'BRL', 'regular');`,
        [productId],
      );
      await client.query(
        `INSERT INTO commerce.stock_levels (environment, product_id, quantity_available, location)
         VALUES ('prod', $1, 10, 'main');`,
        [productId],
      );

      createdTires += 1;
      console.log(`  + criado ${t.tireSize} ${t.position} (${t.construction}) → product_id=${productId.slice(0, 8)}`);
    }
    console.log(`  Total tire_specs novos: ${createdTires}\n`);

    // ---------- ETAPA 2: vehicle_models ----------
    console.log('ETAPA 2 — Modelos novos');
    const modelIdByKey = new Map<string, string>();
    let createdModels = 0;
    let skippedModels = 0;

    for (const m of NEW_MODELS) {
      // Checa se ja existe
      const exists = await client.query(
        `SELECT id FROM commerce.vehicle_models
         WHERE environment='prod' AND deleted_at IS NULL
           AND make=$1 AND model=$2
           AND (variant IS NOT DISTINCT FROM $3)
           AND (year_start IS NOT DISTINCT FROM $4)
         LIMIT 1;`,
        [m.make, m.model, m.variant, m.yearStart],
      );
      if (exists.rows.length > 0) {
        modelIdByKey.set(`${m.make}|${m.model}|${m.variant}|${m.yearStart}`, exists.rows[0].id);
        skippedModels += 1;
        console.log(`  ${m.make} ${m.model} ${m.variant ?? ''}: ja existe, pulando`);
        continue;
      }
      const res = await client.query(
        `INSERT INTO commerce.vehicle_models
           (environment, vehicle_type, make, model, variant, year_start, year_end, displacement_cc, aliases)
         VALUES ('prod', 'motorcycle', $1, $2, $3, $4, $5, $6, $7)
         RETURNING id;`,
        [m.make, m.model, m.variant, m.yearStart, m.yearEnd, m.cc, m.aliases],
      );
      const id = res.rows[0].id;
      modelIdByKey.set(`${m.make}|${m.model}|${m.variant}|${m.yearStart}`, id);
      createdModels += 1;
      console.log(`  + ${m.make} ${m.model} ${m.variant ?? ''} (${m.yearStart}-${m.yearEnd})`);
    }
    console.log(`  Total modelos novos: ${createdModels} | pulados: ${skippedModels}\n`);

    // ---------- ETAPA 3: vehicle_fitments ----------
    console.log('ETAPA 3 — Fitments');
    let createdFitments = 0;
    let skippedFitments = 0;
    let failedFitments = 0;
    for (const m of NEW_MODELS) {
      const modelId = modelIdByKey.get(`${m.make}|${m.model}|${m.variant}|${m.yearStart}`);
      if (!modelId) {
        console.log(`  ! ${m.make} ${m.model}: modelo sem id (pulado)`);
        continue;
      }
      for (const f of m.fitments) {
        const tsKey = `${f.tireSize}|${f.position}`;
        const tireSpecId = tireSpecIdBySize.get(tsKey);
        if (!tireSpecId) {
          console.log(`  ! ${m.make} ${m.model}: tire_spec ${f.tireSize} ${f.position} nao encontrado`);
          failedFitments += 1;
          continue;
        }
        // Verifica se ja existe fitment (idempotencia)
        const exists = await client.query(
          `SELECT 1 FROM commerce.vehicle_fitments
           WHERE environment='prod' AND vehicle_model_id=$1 AND tire_spec_id=$2 AND "position"=$3;`,
          [modelId, tireSpecId, f.position],
        );
        if (exists.rows.length > 0) {
          skippedFitments += 1;
          continue;
        }
        await client.query(
          `INSERT INTO commerce.vehicle_fitments
             (environment, vehicle_model_id, tire_spec_id, "position", is_oem, source, confidence_level)
           VALUES ('prod', $1, $2, $3, true, 'manual', 0.95);`,
          [modelId, tireSpecId, f.position],
        );
        createdFitments += 1;
      }
    }
    console.log(`  Fitments criados: ${createdFitments} | pulados (ja existiam): ${skippedFitments} | falharam: ${failedFitments}\n`);

    // ---------- SMOKE TESTS ----------
    console.log('SMOKE TESTS');
    for (const probe of ['Fan', 'Titan', 'Factor', 'MT-07', 'Hornet', 'CB 300', 'Twister', 'YBR 150']) {
      const r = await client.query(
        `SELECT * FROM commerce.resolve_vehicle_model('prod'::env_t, $1, NULL, 0.4);`,
        [probe],
      );
      console.log(`  resolve_vehicle_model('${probe}'): ${r.rows.length} resultados`);
      for (const row of r.rows.slice(0, 2)) {
        console.log(`    ${row.make} ${row.model} ${row.variant ?? ''} | ${row.match_type} sim=${row.match_similarity}`);
      }
    }

    // smoke: find_compatible_tires(CG 160 Fan, rear)
    const cg = await client.query(
      `SELECT id FROM commerce.vehicle_models
       WHERE environment='prod' AND deleted_at IS NULL AND make='Honda' AND model='CG 160' AND variant='Fan'
       LIMIT 1;`,
    );
    if (cg.rows.length > 0) {
      const compat = await client.query(
        `SELECT * FROM commerce.find_compatible_tires('prod'::env_t, $1, NULL);`,
        [cg.rows[0].id],
      );
      console.log(`  find_compatible_tires(CG 160 Fan, *): ${compat.rows.length}`);
      for (const c of compat.rows) {
        console.log(`    ${c.tire_size} ${c.fitment_position} | preco=${c.current_price} | estoque=${c.total_stock}`);
      }
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log('\n*** COMMIT efetuado. ***');
    } else {
      await client.query('ROLLBACK');
      console.log('\n*** DRY-RUN: ROLLBACK efetuado. Rode com COMMIT=1 pra aplicar. ***');
    }
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('\nErro — ROLLBACK efetuado:', err.message);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch(() => process.exit(1));
