import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import { createPartnerFixture, getStockQty } from './helpers/partner-fixtures';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  process.env.FAREJADOR_ENV = 'test';
  process.env.NODE_ENV = 'test';
  process.env.CHATWOOT_HMAC_SECRET = 'test-secret-not-used-here';
  process.env.ADMIN_AUTH_TOKEN = 'admin-not-used-here-1234567890';
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

describe('estoque simples do parceiro no banco novo', () => {
  it('corrige somente a própria unidade e preserva reservas', async () => {
    const operation = await import('../../src/parceiro/operation-stock-simple.js');
    const own = await createPartnerFixture(db.pool, { initialStockQty: 5 });
    const other = await createPartnerFixture(db.pool, { initialStockQty: 7 });

    await operation.correctSimpleOperationStockBalance(own.ctx, 'Proprietário', own.stockId, 4);
    expect(await getStockQty(db.pool, own.stockId)).toBe(4);
    expect(await getStockQty(db.pool, other.stockId)).toBe(7);

    await expect(operation.correctSimpleOperationStockBalance(
      own.ctx, 'Proprietário', other.stockId, 3,
    )).rejects.toMatchObject({ code: 'stock_not_found', status: 404 });

    await db.pool.query(
      `UPDATE commerce.partner_stock_levels SET quantity_reserved=3 WHERE id=$1`,
      [own.stockId],
    );
    await expect(operation.correctSimpleOperationStockBalance(
      own.ctx, 'Proprietário', own.stockId, 2,
    )).rejects.toMatchObject({ code: 'stock_balance_below_reserved', status: 409 });
  });

  it('cadastra um pneu completo sem inventar custo e impede duplicidade', async () => {
    const operation = await import('../../src/parceiro/operation-stock-simple.js');
    const fixture = await createPartnerFixture(db.pool);
    const input = {
      tire_size: '110/70-17', tire_width_mm: 110, tire_aspect_ratio: 70,
      tire_rim_diameter: 17, brand: 'Pirelli', tire_condition: 'novo' as const,
      quantity_on_hand: 5, minimum_quantity: 2, sale_price: 149.9,
    };

    const result = await operation.createSimpleOperationTire(
      fixture.ctx, 'Proprietário', input,
    );
    const saved = await db.pool.query<{
      unit_id: string; average_cost: string | null; sale_price: string;
      quantity_on_hand: number; stock_status: string;
    }>(
      `SELECT unit_id,average_cost::text,sale_price::text,quantity_on_hand,stock_status
         FROM commerce.partner_stock_levels WHERE id=$1`,
      [result.stock_id],
    );
    expect(saved.rows[0]).toMatchObject({
      unit_id: fixture.unitId, average_cost: null, sale_price: '149.90',
      quantity_on_hand: 5, stock_status: 'in_stock',
    });
    await expect(operation.createSimpleOperationTire(
      fixture.ctx, 'Proprietário', input,
    )).rejects.toMatchObject({ code: 'stock_item_already_exists', status: 409 });
  });
});
