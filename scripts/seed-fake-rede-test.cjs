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

    await client.query('COMMIT');
    console.log('=== SEED FAKE REDE (test) ===');
    console.log(`produto: ${productId}  (${FAKE_PRODUCT_CODE}, preço central R$ 200,00)`);
    for (const c of created) {
      console.log(`  ${c.slug.padEnd(13)} unit_id=${c.unitId}  municipio="${c.municipio}"  modo=${c.serviceMode}  estoque=${c.stockQty}`);
    }
    console.log('\nPronto. Próximo: scripts/prova-regua-rede-test.* (chama decideStoreForItems com as flags ligadas).');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
