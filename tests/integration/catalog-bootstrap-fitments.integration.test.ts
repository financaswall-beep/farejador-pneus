import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

let db: IntegrationDb;
let createCatalogProduct:
  typeof import('../../src/admin/painel/queries-catalogo-create.js').createCatalogProduct;
let registerWholesalePurchase:
  typeof import('../../src/admin/painel/queries-fornecedores-registro.js').registerWholesalePurchase;
let getCatalogOverview:
  typeof import('../../src/admin/painel/queries-catalogo.js').getCatalogOverview;
let addCatalogCompatibility:
  typeof import('../../src/admin/painel/queries-catalogo-compatibilidade.js').addCatalogCompatibility;
let createCatalogFitmentDiscovery:
  typeof import('../../src/admin/painel/queries-catalogo-compatibilidade.js').createCatalogFitmentDiscovery;
let reviewCatalogFitmentDiscovery:
  typeof import('../../src/admin/painel/queries-catalogo-compatibilidade.js').reviewCatalogFitmentDiscovery;
let removeCatalogCompatibility:
  typeof import('../../src/admin/painel/queries-catalogo-compatibilidade.js').removeCatalogCompatibility;

beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    WHOLESALE_FINANCE: 'false',
  });
  ({ createCatalogProduct }
    = await import('../../src/admin/painel/queries-catalogo-create.js'));
  ({ registerWholesalePurchase }
    = await import('../../src/admin/painel/queries-fornecedores-registro.js'));
  ({ getCatalogOverview }
    = await import('../../src/admin/painel/queries-catalogo.js'));
  ({ addCatalogCompatibility, createCatalogFitmentDiscovery,
    reviewCatalogFitmentDiscovery, removeCatalogCompatibility }
    = await import('../../src/admin/painel/queries-catalogo-compatibilidade.js'));
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

describe('migration 0202 — catálogo inicial e compatibilidade por medida', () => {
  it('cria dado mestre e preço sem efeito físico ou financeiro', async () => {
    const created = await createCatalogProduct({
      measure: '90/90R18', brand: 'Levorin', tireCondition: 'meia_vida',
      productCode: 'LEV-909018-MV', productName: 'Pneu Levorin',
      priceAmount: 45, actorLabel: 'Dono', environment: 'test',
      treadPattern: 'Matrix Sport', loadIndex: '57', speedRating: 'P',
      position: 'rear',
    }, db.pool);
    expect(created).toMatchObject({ tire_size: '90/90-18', price_amount: 45 });

    const originalSpec = await db.pool.query<{
      tread_pattern: string; load_index: string; speed_rating: string; position: string;
    }>(
      `SELECT tread_pattern,load_index,speed_rating,position
         FROM commerce.tire_specs
        WHERE environment='test' AND product_id=$1`,
      [created.product_id],
    );
    expect(originalSpec.rows[0]).toEqual({
      tread_pattern: 'Matrix Sport', load_index: '57', speed_rating: 'P', position: 'rear',
    });

    const effects = await db.pool.query<{
      stocks: string; purchases: string; orders: string; ledger: string;
    }>(
      `SELECT
         (SELECT count(*) FROM commerce.wholesale_stock WHERE environment='test') stocks,
         (SELECT count(*) FROM commerce.wholesale_purchases WHERE environment='test') purchases,
         (SELECT count(*) FROM commerce.orders WHERE environment='test') orders,
         (SELECT count(*) FROM finance.matriz_ledger_entries WHERE environment='test') ledger`,
    );
    expect(effects.rows[0]).toEqual({ stocks: '0', purchases: '0', orders: '0', ledger: '0' });
    const partnerGrant = await db.pool.query<{ allowed: boolean }>(
      `SELECT has_table_privilege('farejador_partner_app','commerce.tire_specs','SELECT') allowed`,
    );
    expect(partnerGrant.rows[0]?.allowed).toBe(true);

    const purchase = await registerWholesalePurchase({
      environment: 'test',
      new_supplier: { name: 'Fornecedor da ficha existente' },
      items: [{
        measure: '90/90-18', brand: 'Levorin', tire_condition: 'meia_vida',
        quantity: 3, unit_cost: 30,
      }],
      created_by: 'Dono', receipt_status: 'received', idempotency_key: randomUUID(),
    }, db.pool);
    expect(purchase.catalog_blockers).toEqual([]);

    const reused = await db.pool.query<{
      products: string; specs: string; tread_pattern: string; load_index: string;
      speed_rating: string; position: string;
    }>(
      `SELECT
         (SELECT count(*) FROM commerce.products p
           JOIN commerce.tire_specs ts ON ts.product_id=p.id AND ts.environment=p.environment
          WHERE p.environment='test' AND p.brand='Levorin'
            AND p.tire_condition='meia_vida' AND ts.tire_size='90/90-18') products,
         (SELECT count(*) FROM commerce.tire_specs
          WHERE environment='test' AND product_id=$1) specs,
         ts.tread_pattern,ts.load_index,ts.speed_rating,ts.position
        FROM commerce.tire_specs ts
       WHERE ts.environment='test' AND ts.product_id=$1`,
      [created.product_id],
    );
    expect(reused.rows[0]).toEqual({
      products: '1', specs: '1', tread_pattern: 'Matrix Sport', load_index: '57',
      speed_rating: 'P', position: 'rear',
    });
  });

  it('expõe na fila de conferência o produto criado sem posição comprovada', async () => {
    const pending = await createCatalogProduct({
      measure: '100/80-17', brand: 'Rinaldi', tireCondition: 'meia_vida',
      productCode: 'RIN-1008017-MV', productName: 'Pneu Rinaldi',
      priceAmount: 50, actorLabel: 'Dono', environment: 'test',
      treadPattern: 'Produto ainda em conferência', position: null,
    }, db.pool);

    const catalog = await getCatalogOverview('test', db.pool);
    expect(catalog.summary.without_position).toBeGreaterThanOrEqual(1);
    expect(catalog.rows).toContainEqual(expect.objectContaining({
      product_id: pending.product_id,
      tire_size: '100/80-17',
      tire_position: null,
      tread_pattern: 'Produto ainda em conferência',
      catalogued: true,
    }));
  });

  it('mantém períodos separados na aprovação, edição, cópia e consulta por ano', async () => {
    const vehicleModelId = randomUUID();
    const vehicleName = 'Twister Períodos';
    await db.pool.query(`INSERT INTO commerce.vehicle_models
      (id,environment,vehicle_type,make,model,year_start,year_end)
      VALUES ($1,'test','motorcycle','Honda',$2,2016,2022)`, [vehicleModelId, vehicleName]);
    const product = (brand: string) => createCatalogProduct({
      measure: '140/70-17', vehicleType: 'motorcycle', brand, tireCondition: 'novo',
      productCode: 'PER-' + brand, productName: brand, position: 'rear', actorLabel: 'teste', environment: 'test',
    }, db.pool);
    const { product_id: productId } = await product('MarcaA');
    const base = { productId, vehicleModelId, position: 'rear' as const, actorLabel: 'teste',
      environment: 'test' as const, reason: 'Manual conferido' };
    const manual = { ...base, isOem: false, source: 'manual' as const, confidenceLevel: 0.8 };
    const research = { ...base, sourceUrl: 'https://example.org/manual', evidenceSummary: 'Medida traseira',
      suggestedIsOem: false, confidenceLevel: 0.8 };
    const older = await createCatalogFitmentDiscovery({ ...research, yearStart: 2016, yearEnd: 2017 }, db.pool);
    const newer = await createCatalogFitmentDiscovery({ ...research, yearStart: 2022, yearEnd: 2022 }, db.pool);
    for (const d of [older, newer]) {
      await reviewCatalogFitmentDiscovery({ ...base, discoveryId: d.discovery_id, decision: 'approve' }, db.pool);
    }
    await addCatalogCompatibility({ ...manual, yearStart: 2022, yearEnd: 2022 }, db.pool);
    const copied = await product('MarcaB');
    const { getCatalogCompatibility } = await import('../../src/admin/painel/queries-catalogo-compatibilidade.js');
    const periods = async (id: string) => (await getCatalogCompatibility(id, 'test', db.pool)).rows
      .map(row => [row.year_start, row.year_end]);
    for (const id of [productId, copied.product_id]) expect(await periods(id)).toEqual([[2016,2017],[2022,2022]]);
    const { buscarCompatibilidadeMatriz } = await import('../../src/atendente-v2/matriz-product-search.js');
    const client = await db.pool.connect();
    try {
      for (const [year, expected] of [[2016,2],[2017,2],[2018,0],[2022,2]] as const) {
        const rows = await buscarCompatibilidadeMatriz(client, { environment: 'test', moto_modelo: vehicleName,
          moto_ano: year, posicao_pneu: 'rear', limit: 10 });
        expect(rows.find(row => row.vehicle_model_id === vehicleModelId)?.produtos.length ?? 0).toBe(expected);
        const legacy = await client.query("SELECT * FROM commerce.find_compatible_tires('test',$1,'rear',$2)",[vehicleModelId,year]);
        expect(legacy.rowCount).toBe(expected);
      }
    } finally { client.release(); }
    await expect(removeCatalogCompatibility(base, db.pool)).rejects.toThrow('catalog_fitment_period_ambiguous');
    const previousPeriod = { year_start: 2016, year_end: 2017 };
    await expect(addCatalogCompatibility({ ...manual, previousPeriod, yearStart: 2022, yearEnd: 2022 }, db.pool))
      .rejects.toThrow('catalog_fitment_period_already_exists');
    await addCatalogCompatibility({ ...manual, previousPeriod, yearStart: 2017, yearEnd: 2017 }, db.pool);
    await expect(removeCatalogCompatibility({ ...base, previousPeriod }, db.pool)).rejects.toThrow('catalog_fitment_period_not_found');
    await removeCatalogCompatibility({ ...base, previousPeriod: { year_start: 2017, year_end: 2017 } }, db.pool);
    for (const id of [productId, copied.product_id]) expect(await periods(id)).toEqual([[2022,2022]]);
    // Repetir uma faixa aberta não duplica a linha. Duas evidências para 2022 não duplicam a oferta.
    for (let i = 0; i < 2; i++) await addCatalogCompatibility({ ...manual, yearStart: 2021, yearEnd: null }, db.pool);
    expect(await periods(productId)).toEqual([[2021,null],[2022,2022]]);
    const { buscarCompatibilidade } = await import('../../src/atendente/tools/commerce-tools.js');
    const lookup = await db.pool.connect();
    try {
      for (const search of [buscarCompatibilidade, buscarCompatibilidadeMatriz]) {
        const rows = await search(lookup, { environment:'test', moto_modelo:vehicleName, moto_ano:2022,
          posicao_pneu:'rear', limit:10 });
        expect(rows.find(row => row.vehicle_model_id === vehicleModelId)?.produtos).toHaveLength(2);
      }
    } finally { lookup.release(); }
    const catalogBefore = await getCatalogOverview('test', db.pool);
    expect(catalogBefore.rows).toContainEqual(expect.objectContaining({ product_id: productId, compatibility_count: 1 }));
    await db.pool.query("UPDATE commerce.vehicle_models SET deleted_at=now() WHERE environment='test' AND id=$1", [vehicleModelId]);
    const catalogAfter = await getCatalogOverview('test', db.pool);
    expect(catalogAfter.rows).toContainEqual(expect.objectContaining({ product_id: productId, compatibility_count: 0 }));
    expect(await periods(productId)).toEqual([]);
  });

  it('propaga homologação e promoção pesquisada para toda a medida', async () => {
    const second = await createCatalogProduct({
      measure: '90/90-18', brand: 'Technic', tireCondition: 'meia_vida',
      productCode: 'TEC-909018-MV', productName: 'Pneu Technic',
      actorLabel: 'Dono', environment: 'test',
    }, db.pool);
    const first = await db.pool.query<{ id: string }>(
      `SELECT id FROM commerce.products WHERE environment='test' AND brand='Levorin'`,
    );
    const firstProductId = first.rows[0]!.id;
    const vehicleOne = randomUUID();
    const vehicleTwo = randomUUID();
    await db.pool.query(
      `INSERT INTO commerce.vehicle_models
         (id,environment,vehicle_type,make,model,variant,year_start)
       VALUES ($1,'test','motorcycle','Honda','CG 160','Fan',2024),
              ($2,'test','motorcycle','Yamaha','Factor 150',NULL,2024)`,
      [vehicleOne, vehicleTwo],
    );

    const homologated = await addCatalogCompatibility({
      productId: firstProductId, vehicleModelId: vehicleOne, position: 'rear',
      isOem: true, source: 'manufacturer', confidenceLevel: 1,
      yearStart: 2016, yearEnd: 2026,
      reason: 'Manual oficial', actorLabel: 'Dono', environment: 'test',
    }, db.pool);
    expect(homologated.fitments_created).toBe(2);
    const gapsAfterDirect = await db.pool.query(
      `SELECT * FROM commerce.catalog_fitment_measure_gaps WHERE environment='test'`,
    );
    expect(gapsAfterDirect.rows).toHaveLength(0);
    const directYears = await db.pool.query(
      `SELECT DISTINCT year_start,year_end FROM commerce.vehicle_fitments
        WHERE environment='test' AND vehicle_model_id=$1`,
      [vehicleOne],
    );
    expect(directYears.rows).toEqual([{ year_start: 2016, year_end: 2026 }]);
    const compatibleInRange = await db.pool.query(
      `SELECT product_id FROM commerce.find_compatible_tires('test',$1,'rear',2025)`,
      [vehicleOne],
    );
    const incompatibleAfterRange = await db.pool.query(
      `SELECT product_id FROM commerce.find_compatible_tires('test',$1,'rear',2027)`,
      [vehicleOne],
    );
    expect(compatibleInRange.rows).toHaveLength(2);
    expect(incompatibleAfterRange.rows).toHaveLength(0);

    const candidate = await createCatalogFitmentDiscovery({
      productId: second.product_id, vehicleModelId: vehicleTwo, position: 'front',
      sourceUrl: 'https://fabricante.example/factor-150',
      sourceTitle: 'Manual Factor 150', evidenceSummary: 'Tabela dianteira 90/90-18',
      suggestedIsOem: true, confidenceLevel: 0.9,
      yearStart: 2020, yearEnd: 2025,
      actorLabel: 'Dono', environment: 'test',
    }, db.pool);
    const beforeReview = await db.pool.query(
      `SELECT count(*) total FROM commerce.vehicle_fitments
        WHERE environment='test' AND vehicle_model_id=$1`,
      [vehicleTwo],
    );
    expect(beforeReview.rows[0].total).toBe('0');

    const reviewed = await reviewCatalogFitmentDiscovery({
      productId: firstProductId, discoveryId: candidate.discovery_id,
      decision: 'approve', reason: 'Fonte conferida', actorLabel: 'Dono',
      environment: 'test',
    }, db.pool);
    expect(reviewed).toEqual({ status: 'promoted', fitments_promoted: 2 });
    const promotedYears = await db.pool.query(
      `SELECT DISTINCT year_start,year_end FROM commerce.vehicle_fitments
        WHERE environment='test' AND vehicle_model_id=$1`,
      [vehicleTwo],
    );
    expect(promotedYears.rows).toEqual([{ year_start: 2020, year_end: 2025 }]);
    const promotionFilm = await db.pool.query(
      `SELECT count(*) total FROM commerce.fitment_discovery_promotions
        WHERE environment='test' AND discovery_id=$1`,
      [candidate.discovery_id],
    );
    expect(promotionFilm.rows[0].total).toBe('2');
    const gapsAfterPromotion = await db.pool.query(
      `SELECT * FROM commerce.catalog_fitment_measure_gaps WHERE environment='test'`,
    );
    expect(gapsAfterPromotion.rows).toHaveLength(0);

    const removed = await removeCatalogCompatibility({
      productId: firstProductId, vehicleModelId: vehicleTwo, position: 'front',
      reason: 'Aplicação incompatível após conferência física', actorLabel: 'Dono',
      environment: 'test',
    }, db.pool);
    expect(removed.fitments_removed).toBe(2);
    const removedFitments = await db.pool.query(
      `SELECT count(*) total FROM commerce.vehicle_fitments
        WHERE environment='test' AND vehicle_model_id=$1 AND position='front'`,
      [vehicleTwo],
    );
    expect(removedFitments.rows[0].total).toBe('0');
    const preservedFilm = await db.pool.query(
      `SELECT count(*) total FROM commerce.fitment_discovery_promotions
        WHERE environment='test' AND discovery_id=$1`,
      [candidate.discovery_id],
    );
    expect(preservedFilm.rows[0].total).toBe('2');
    const preservedDiscovery = await db.pool.query(
      `SELECT status,promoted_to_fitment_id FROM commerce.fitment_discoveries
        WHERE environment='test' AND id=$1`,
      [candidate.discovery_id],
    );
    expect(preservedDiscovery.rows[0]).toMatchObject({
      status: 'promoted', promoted_to_fitment_id: expect.any(String),
    });
  });
});
