import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPartnerFixture } from './helpers/partner-fixtures';
import {
  buildRestrictedConnectionString,
  startPostgres,
  stopPostgres,
  type IntegrationDb,
} from './helpers/postgres';

let db: IntegrationDb;
let partnerPool: typeof import('../../src/parceiro/db.js').partnerPool;
let getPartnerPanelCatalog:
  typeof import('../../src/parceiro/panel-catalog.js').getPartnerPanelCatalog;

beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    PARTNER_DATABASE_URL: buildRestrictedConnectionString(db.connectionString),
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'admin-test-token',
  });
  ({ partnerPool } = await import('../../src/parceiro/db.js'));
  ({ getPartnerPanelCatalog } = await import('../../src/parceiro/panel-catalog.js'));
}, 360_000);

afterAll(async () => {
  if (partnerPool) await partnerPool.end();
  if (db) await stopPostgres(db);
});

describe('Catálogo da Operação — integração com estoque local', () => {
  it('casa variante sem product_id, isola a unidade e oculta detalhes do funcionário', async () => {
    const own = await createPartnerFixture(db.pool, { slugSuffix: randomUUID().slice(0, 8) });
    await createPartnerFixture(db.pool, {
      slugSuffix: randomUUID().slice(0, 8), initialStockQty: 99,
    });
    const { createCatalogProduct } = await import(
      '../../src/admin/painel/queries-catalogo-create.js'
    );
    const product = await createCatalogProduct({
      measure: '90/90-18', brand: 'Michelin', tireCondition: 'meia_vida',
      productCode: `MIC-${randomUUID().slice(0, 8)}`,
      productName: 'Pneu Michelin 90/90-18', priceAmount: 180,
      actorLabel: 'Teste', environment: 'test',
    }, db.pool);

    const ownerCatalog = await getPartnerPanelCatalog(own.ctx);
    const row = ownerCatalog.rows.find((item) => item.product_id === product.product_id);
    expect(row).toMatchObject({
      has_local_stock: true,
      local_quantity_on_hand: 10,
      local_quantity_available: 10,
      local_sale_price_min: 150,
    });
    expect(row?.local_stock_entries).toHaveLength(1);
    expect(row?.local_stock_entries[0]).toMatchObject({ stock_id: own.stockId, sale_price: 150 });
    expect(row?.local_stock_entries[0]).not.toHaveProperty('supplier_name');

    const employeeCatalog = await getPartnerPanelCatalog({ ...own.ctx, role: 'funcionario' });
    expect(employeeCatalog.rows.find((item) => item.product_id === product.product_id))
      .toMatchObject({ local_quantity_on_hand: 10, local_stock_entries: [] });
  });
});
