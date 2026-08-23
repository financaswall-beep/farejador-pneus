import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

let db: IntegrationDb;
let createCatalogProduct:
  typeof import('../../src/admin/painel/queries-catalogo-create.js').createCatalogProduct;
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
  });
  ({ createCatalogProduct }
    = await import('../../src/admin/painel/queries-catalogo-create.js'));
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
    }, db.pool);
    expect(created).toMatchObject({ tire_size: '90/90-18', price_amount: 45 });

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
      reason: 'Manual oficial', actorLabel: 'Dono', environment: 'test',
    }, db.pool);
    expect(homologated.fitments_created).toBe(2);
    const gapsAfterDirect = await db.pool.query(
      `SELECT * FROM commerce.catalog_fitment_measure_gaps WHERE environment='test'`,
    );
    expect(gapsAfterDirect.rows).toHaveLength(0);

    const candidate = await createCatalogFitmentDiscovery({
      productId: second.product_id, vehicleModelId: vehicleTwo, position: 'front',
      sourceUrl: 'https://fabricante.example/factor-150',
      sourceTitle: 'Manual Factor 150', evidenceSummary: 'Tabela dianteira 90/90-18',
      suggestedIsOem: true, confidenceLevel: 0.9,
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
