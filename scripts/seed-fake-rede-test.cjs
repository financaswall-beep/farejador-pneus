'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// SEED dos 4 parceiros FAKE pra provar o motor de distribuição (Fase 2).
// environment='test' SEMPRE. Idempotente (limpa antes de criar). NÃO toca prod.
//   node --env-file=.env scripts/seed-fake-rede-test.cjs
//
// Motor v1 roteia por MUNICÍPIO (bairro é peça separada — ROUTING_NEIGHBORHOOD),
// então os fake usam municípios distintos em vez de bairros:
//   A,B = "rio de janeiro" (both, com estoque) → a dupla que DISPUTA pela régua
//   C   = "sao goncalo"    (só entrega, com estoque)
//   D   = "marica"         (só retirada, SEM estoque)
// Casos provados em scripts/prova-regua-rede-test.* (a criar).
// ─────────────────────────────────────────────────────────────────────────────
const { Client } = require('pg');
const { limpar, loadDatabaseUrl, assertTest, ENV, FAKE_PRODUCT_CODE } = require('./limpar-fake-rede-test.cjs');

const FAKES = [
  { slug: 'fake-rede-a', tradeName: 'FAKE REDE A', municipio: 'rio de janeiro', serviceMode: 'both', stockQty: 10 },
  { slug: 'fake-rede-b', tradeName: 'FAKE REDE B', municipio: 'rio de janeiro', serviceMode: 'both', stockQty: 10 },
  { slug: 'fake-rede-c', tradeName: 'FAKE REDE C', municipio: 'sao goncalo', serviceMode: 'delivery', stockQty: 10 },
  { slug: 'fake-rede-d', tradeName: 'FAKE REDE D', municipio: 'marica', serviceMode: 'pickup', stockQty: 0 },
];

// ── Fakes GEO (camada de proximidade): mesma cidade-scope isolada (não colide no
// LIKE com "rio de janeiro" dos fakes acima), coordenadas REAIS do Rio (links do
// Maps do Wallace) pra distâncias realistas. Distâncias a partir de COPACABANA
// (-22.984613,-43.198278), o ponto do cliente na prova:
//   geo-leme ~4km · geo-tijuca ~7km   (≤10 → anel 1)
//   geo-meier ~13km · geo-niteroi ~13km · geo-madureira ~19km  (≤20 → anel 2)
//   geo-barra ~22km  (≤30 → anel 3) · geo-itaborai ~44km (além → caso E)
//   geo-bairro: coladinho em Copa, mas só cobre o BAIRRO 'tijuca' (caso D, 4a).
const GEO_MUNI = 'zona-sul-geo';
const GEO_FAKES = [
  { slug: 'geo-leme',      tradeName: 'GEO LEME',      lat: -22.962000, lng: -43.166000, serviceMode: 'both',     coverage: 'city',       stockQty: 10 },
  { slug: 'geo-tijuca',    tradeName: 'GEO TIJUCA',    lat: -22.938627, lng: -43.249959, serviceMode: 'both',     coverage: 'city',       stockQty: 10 },
  { slug: 'geo-meier',     tradeName: 'GEO MEIER',     lat: -22.901230, lng: -43.282202, serviceMode: 'both',     coverage: 'city',       stockQty: 10 },
  { slug: 'geo-niteroi',   tradeName: 'GEO NITEROI',   lat: -22.907564, lng: -43.104245, serviceMode: 'both',     coverage: 'city',       stockQty: 10 },
  { slug: 'geo-madureira', tradeName: 'GEO MADUREIRA', lat: -22.873217, lng: -43.338000, serviceMode: 'both',     coverage: 'city',       stockQty: 10 },
  { slug: 'geo-barra',     tradeName: 'GEO BARRA',     lat: -23.001191, lng: -43.414283, serviceMode: 'both',     coverage: 'city',       stockQty: 10 },
  { slug: 'geo-itaborai',  tradeName: 'GEO ITABORAI',  lat: -22.747397, lng: -42.859156, serviceMode: 'both',     coverage: 'city',       stockQty: 10 },
  { slug: 'geo-bairro',    tradeName: 'GEO BAIRRO',    lat: -22.985000, lng: -43.198000, serviceMode: 'delivery', coverage: ['tijuca'],   stockQty: 10 },
];

// ── Fakes PROXIMIDADE-PRIMEIRO: ~30 lojas pra provar que o motor ESCALA e que o "muro
// da cidade" cai. Município isolado (PROX_MUNI) pra NÃO casar no LIKE com cidade real:
//   - prox-madureira: coordenada de Madureira (-22.873,-43.338). Cliente da prova fica
//     em DUQUE DE CAXIAS (-22.800,-43.320), ~8 km dela, mas em CIDADE diferente. Pelo
//     resolver de cidade, Caxias não casa a cobertura → matriz (o muro). Pela proximidade,
//     8 km ≤ 15 (anel de retirada) → prox-madureira atende (o muro caiu).
//   - prox-01..prox-29: aglomerado na Zona Sul (~ -22.97,-43.22), 1–5 km entre si, todas
//     >15 km de Caxias (não competem no caso da divisa). Provam a ESCALA: a partir de um
//     cliente no meio do aglomerado, o motor ranqueia 30 candidatos de forma determinística.
//     1 em cada 6 é só-entrega (prova o filtro de modo: fora do pool de retirada).
const PROX_MUNI = 'proximidade-prox';
const PROX_CLUSTER = { lat: -22.97, lng: -43.22 };
const PROX_FAKES = [
  { slug: 'prox-madureira', tradeName: 'PROX MADUREIRA', lat: -22.873217, lng: -43.338000, serviceMode: 'both', muni: PROX_MUNI, coverage: 'city', stockQty: 10 },
];
for (let i = 1; i <= 29; i++) {
  const angle = (i * 2 * Math.PI) / 29;
  const r = 0.012 + (i % 5) * 0.007; // raio ~1.3 km .. ~4.5 km do centro do aglomerado
  const lat = Number((PROX_CLUSTER.lat + r * Math.cos(angle)).toFixed(6));
  const lng = Number((PROX_CLUSTER.lng + r * Math.sin(angle)).toFixed(6));
  const slug = `prox-${String(i).padStart(2, '0')}`;
  PROX_FAKES.push({
    slug,
    tradeName: `PROX ${String(i).padStart(2, '0')}`,
    lat,
    lng,
    serviceMode: i % 6 === 0 ? 'delivery' : 'both', // ~1 em 6 só-entrega (fora do pickup)
    muni: PROX_MUNI,
    coverage: 'city',
    stockQty: 10,
  });
}

async function createFakeGeo(client, productId, f) {
  // Município da cobertura: GEO_MUNI por padrão; um fake pode escolher o seu (PROX_MUNI).
  const muni = f.muni || GEO_MUNI;
  const unit = await client.query(
    `INSERT INTO core.units (environment, slug, name) VALUES ($1,$2,$3) RETURNING id`,
    [ENV, f.slug, f.tradeName],
  );
  const unitId = unit.rows[0].id;

  const partner = await client.query(
    `INSERT INTO network.partners (environment, legal_name, trade_name, document_number, status, commercial_model)
     VALUES ($1,$2,$3,$4,'active','commission') RETURNING id`,
    [ENV, f.tradeName, f.tradeName, 'fake-' + f.slug],
  );
  const partnerId = partner.rows[0].id;

  await client.query(
    `INSERT INTO network.partner_units (environment, partner_id, unit_id, slug, display_name, status, service_mode, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8)`,
    [ENV, partnerId, unitId, f.slug, f.tradeName, f.serviceMode, f.lat, f.lng],
  );

  if (f.coverage === 'city') {
    await client.query(
      `INSERT INTO network.unit_coverage (environment, unit_id, municipio) VALUES ($1,$2,$3)
       ON CONFLICT (environment, unit_id, municipio, coalesce(neighborhood_canonical,'')) DO NOTHING`,
      [ENV, unitId, muni],
    );
  } else {
    for (const bairro of f.coverage) {
      await client.query(
        `INSERT INTO network.unit_coverage (environment, unit_id, municipio, neighborhood_canonical, coverage_kind)
         VALUES ($1,$2,$3,$4,'neighborhood')
         ON CONFLICT (environment, unit_id, municipio, coalesce(neighborhood_canonical,'')) DO NOTHING`,
        [ENV, unitId, muni, bairro],
      );
    }
  }

  await client.query(
    `INSERT INTO commerce.partner_stock_levels
       (environment, unit_id, product_id, item_name, tire_size, brand,
        quantity_on_hand, minimum_quantity, average_cost, sale_price, is_tracked, stock_status, updated_by)
     VALUES ($1,$2,$3,$4,'175/70-14','FakeBrand',$5,2,120,200,true,'in_stock','seed-fake-rede-geo')`,
    [ENV, unitId, productId, `Pneu Fake ${f.slug}`, f.stockQty],
  );

  return { ...f, unitId };
}

async function createFake(client, productId, f) {
  const unit = await client.query(
    `INSERT INTO core.units (environment, slug, name) VALUES ($1,$2,$3) RETURNING id`,
    [ENV, f.slug, f.tradeName],
  );
  const unitId = unit.rows[0].id;

  const partner = await client.query(
    `INSERT INTO network.partners (environment, legal_name, trade_name, document_number, status, commercial_model)
     VALUES ($1,$2,$3,$4,'active','commission') RETURNING id`,
    [ENV, f.tradeName, f.tradeName, 'fake-' + f.slug],
  );
  const partnerId = partner.rows[0].id;

  const pu = await client.query(
    `INSERT INTO network.partner_units (environment, partner_id, unit_id, slug, display_name, status, service_mode)
     VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING id`,
    [ENV, partnerId, unitId, f.slug, f.tradeName, f.serviceMode],
  );
  const partnerUnitId = pu.rows[0].id;

  await client.query(
    `INSERT INTO network.unit_coverage (environment, unit_id, municipio) VALUES ($1,$2,$3)
     ON CONFLICT (environment, unit_id, municipio, coalesce(neighborhood_canonical,'')) DO NOTHING`,
    [ENV, unitId, f.municipio],
  );

  if (f.stockQty > 0) {
    await client.query(
      `INSERT INTO commerce.partner_stock_levels
         (environment, unit_id, product_id, item_name, tire_size, brand,
          quantity_on_hand, minimum_quantity, average_cost, sale_price, is_tracked, stock_status, updated_by)
       VALUES ($1,$2,$3,$4,'175/70-14','FakeBrand',$5,2,120,200,true,'in_stock','seed-fake-rede')`,
      [ENV, unitId, productId, `Pneu Fake ${f.slug}`, f.stockQty],
    );
  }

  return { ...f, unitId, partnerUnitId };
}

async function main() {
  assertTest();
  const client = new Client({ connectionString: loadDatabaseUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('BEGIN');
    await limpar(client); // reset (idempotência)

    const prod = await client.query(
      `INSERT INTO commerce.products (environment, product_code, product_name, product_type)
       VALUES ($1,$2,$3,'tire') RETURNING id`,
      [ENV, FAKE_PRODUCT_CODE, 'Pneu Fake Rede 175/70 R14'],
    );
    const productId = prod.rows[0].id;
    await client.query(
      `INSERT INTO commerce.product_prices (environment, product_id, price_amount, price_type, valid_from)
       VALUES ($1,$2,$3,'regular', now())`,
      [ENV, productId, 200.0],
    );

    const created = [];
    for (const f of FAKES) created.push(await createFake(client, productId, f));

    const createdGeo = [];
    for (const f of GEO_FAKES) createdGeo.push(await createFakeGeo(client, productId, f));

    const createdProx = [];
    for (const f of PROX_FAKES) createdProx.push(await createFakeGeo(client, productId, f));

    await client.query('COMMIT');
    console.log('=== SEED FAKE REDE (test) ===');
    console.log(`produto: ${productId}  (${FAKE_PRODUCT_CODE}, preço central R$ 200,00)`);
    console.log('— fakes por município (prova da justiça):');
    for (const c of created) {
      console.log(`  ${c.slug.padEnd(14)} unit_id=${c.unitId}  municipio="${c.municipio}"  modo=${c.serviceMode}  estoque=${c.stockQty}`);
    }
    console.log(`— fakes GEO (prova de proximidade, municipio="${GEO_MUNI}"):`);
    for (const c of createdGeo) {
      const cov = c.coverage === 'city' ? 'cidade' : `bairro[${c.coverage.join(',')}]`;
      console.log(`  ${c.slug.padEnd(14)} unit_id=${c.unitId}  (${c.lat},${c.lng})  modo=${c.serviceMode}  cobertura=${cov}  estoque=${c.stockQty}`);
    }
    console.log(`— fakes PROXIMIDADE (${createdProx.length} lojas, prova de escala + divisa, municipio="${PROX_MUNI}"):`);
    console.log(`  prox-madureira em (-22.873,-43.338); aglomerado prox-01..29 ~ (${PROX_CLUSTER.lat},${PROX_CLUSTER.lng}); cliente da prova em Caxias (-22.800,-43.320).`);

    console.log('\nPronto. Próximo: prova-geo-rede-test.ts (cidade, flag OFF = 9/9) + prova-proximidade-rede-test.ts (proximidade, flag ON).');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
