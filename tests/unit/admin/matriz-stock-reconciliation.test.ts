import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let getMatrizStockReconciliation:
  typeof import('../../../src/admin/painel/queries-stock-reconciliation.js').getMatrizStockReconciliation;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ getMatrizStockReconciliation } = await import(
    '../../../src/admin/painel/queries-stock-reconciliation.js'
  ));
});

describe('conciliação sombra do estoque da Matriz', () => {
  it('compara por medida, agrega marcas e não copia nenhum saldo', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { product_id: 'p1', tire_size: '100/80-18', brand: 'Pirelli', legacy_quantity: 10 },
        { product_id: 'p2', tire_size: '100/80R18', brand: 'Levorin', legacy_quantity: 5 },
        { product_id: 'p3', tire_size: '90/90-18', brand: 'Rinaldi', legacy_quantity: 7 },
        { product_id: 'p4', tire_size: '120/80-17', brand: null, legacy_quantity: 0 },
      ] })
      .mockResolvedValueOnce({ rows: [
        { measure: '100/80-18', quantity_on_hand: 2, unit_cost: 15 },
        { measure: '90/90-18', quantity_on_hand: 7, unit_cost: 20 },
        { measure: '130/70-17', quantity_on_hand: 4, unit_cost: 25 },
      ] });
    const db = { query } as unknown as Pool;

    const report = await getMatrizStockReconciliation('test', db);

    expect(report.summary).toMatchObject({
      official_source: 'commerce.wholesale_stock',
      legacy_source: 'commerce.product_full',
      total: 4,
      aligned: 1,
      divergent: 3,
      catalog_only: 1,
      official_only: 1,
    });
    expect(report.rows.find((row) => row.key === '100-80-18')).toMatchObject({
      catalog_brands: ['Levorin', 'Pirelli'],
      legacy_quantity: 15,
      official_quantity: 2,
      status: 'quantity_divergent',
    });
    expect(report.rows.find((row) => row.key === '90-90-18')?.status).toBe('aligned');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/i.test(String(sql)))).toBe(true);
  });
});
