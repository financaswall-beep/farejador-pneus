import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('estoque do galpão por medida e marca', () => {
  let db: IntegrationDb;
  let registerPurchase:
    typeof import('../../src/admin/painel/queries-fornecedores-registro.js').registerWholesalePurchase;
  let decrement:
    typeof import('../../src/admin/painel/wholesale-stock.js').applyWholesaleStockDecrement;
  let priceReport:
    typeof import('../../src/admin/painel/queries-compras-relatorios.js').getWholesalePriceReport;
  let catalogOverview:
    typeof import('../../src/admin/painel/queries-catalogo.js').getCatalogOverview;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret',
      ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'false',
    });
    db = await startPostgres();
    ({ registerWholesalePurchase: registerPurchase }
      = await import('../../src/admin/painel/queries-fornecedores-registro.js'));
    ({ applyWholesaleStockDecrement: decrement }
      = await import('../../src/admin/painel/wholesale-stock.js'));
    ({ getWholesalePriceReport: priceReport }
      = await import('../../src/admin/painel/queries-compras-relatorios.js'));
    ({ getCatalogOverview: catalogOverview }
      = await import('../../src/admin/painel/queries-catalogo.js'));

    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type,brand)
       VALUES ('test',$1,'Pneu multimarcas','tire','Pirelli')
       RETURNING id`,
      [`MULTI-${Date.now()}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,'90/90-18',90,90,18)`,
      [product.rows[0]!.id],
    );
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
  });

  it('registra duas marcas na mesma compra e movimenta apenas a variante vendida', async () => {
    await registerPurchase({
      environment: 'test',
      new_supplier: { name: 'Fornecedor multimarcas' },
      created_by: 'teste-multimarcas',
      receipt_status: 'received',
      idempotency_key: randomUUID(),
      items: [
        { measure: '90/90-18', brand: 'Pirelli', quantity: 2, unit_cost: 100 },
        { measure: '90/90-18', brand: 'Metzeler', quantity: 3, unit_cost: 120 },
      ],
    }, db.pool);

    const before = await db.pool.query<{
      brand: string; quantity_on_hand: number; unit_cost: string;
    }>(
      `SELECT brand,quantity_on_hand,unit_cost::text
         FROM commerce.wholesale_stock
        WHERE environment='test' AND measure='90/90-18'
        ORDER BY brand`,
    );
    expect(before.rows).toEqual([
      { brand: 'Metzeler', quantity_on_hand: 3, unit_cost: '120.00' },
      { brand: 'Pirelli', quantity_on_hand: 2, unit_cost: '100.00' },
    ]);

    const prices = await priceReport({ period: 'all' }, 'test', db.pool) as Array<{
      measure: string; brand: string; avg_cost: string;
    }>;
    expect(prices.map((row) => ({
      measure: row.measure, brand: row.brand, avg_cost: row.avg_cost,
    }))).toEqual([
      { measure: '90/90-18', brand: 'Metzeler', avg_cost: '120.00' },
      { measure: '90/90-18', brand: 'Pirelli', avg_cost: '100.00' },
    ]);

    const catalog = await catalogOverview('test', db.pool);
    expect(catalog.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tire_size: '90/90-18', brand: 'Pirelli', catalogued: true,
        official_quantity_on_hand: 2,
      }),
      expect.objectContaining({
        tire_size: '90/90-18', brand: 'Metzeler', catalogued: false,
        official_quantity_on_hand: 3, block_reason: 'catalog_product_missing',
      }),
    ]));

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await decrement(client as PoolClient, 'test', [{
        measure: '90/90-18', brand: 'Metzeler', quantity: 2,
      }], true, 'venda-multimarcas');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const after = await db.pool.query<{ brand: string; quantity_on_hand: number }>(
      `SELECT brand,quantity_on_hand
         FROM commerce.wholesale_stock
        WHERE environment='test' AND measure='90/90-18'
        ORDER BY brand`,
    );
    expect(after.rows).toEqual([
      { brand: 'Metzeler', quantity_on_hand: 1 },
      { brand: 'Pirelli', quantity_on_hand: 2 },
    ]);

    const movement = await db.pool.query<{ brand: string; qty_delta: number }>(
      `SELECT brand,qty_delta
         FROM commerce.wholesale_stock_movements
        WHERE environment='test' AND ref='venda-multimarcas'
        ORDER BY created_at DESC LIMIT 1`,
    );
    expect(movement.rows[0]).toEqual({ brand: 'Metzeler', qty_delta: -2 });
  });
});
