import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let getPainelProdutos: typeof import('../../../src/admin/painel/queries-pedidos.js').getPainelProdutos;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ getPainelProdutos } = await import('../../../src/admin/painel/queries-pedidos.js'));
});

describe('produtos do Varejo usam a fonte oficial', () => {
  it('prioriza o galpão e expõe a mesma trava da venda atômica', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { product_id: 'p-sem', product_code: 'SEM', product_name: 'Sem estoque', product_type: 'tire', brand: null,
          tire_size: '100/90-18', tire_position: 'rear', price_amount: '100', currency: 'BRL' },
        { product_id: 'p-ok', product_code: 'OK', product_name: 'Disponível', product_type: 'tire', brand: 'Rinaldi',
          tire_size: '100/80-18', tire_position: 'rear', price_amount: '120', currency: 'BRL' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { measure: '100/80-18', quantity_on_hand: 2, unit_cost: '15' },
      ] });
    const db = { query } as unknown as Pool;

    const rows = await getPainelProdutos(100, db) as Array<Record<string, unknown>>;

    expect(rows[0]).toMatchObject({
      product_id: 'p-ok',
      total_stock_available: 2,
      official_quantity_on_hand: 2,
      official_unit_cost: 15,
      stock_source: 'commerce.wholesale_stock',
      walkin_sellable: true,
      walkin_block_reason: null,
    });
    expect(rows[1]).toMatchObject({
      product_id: 'p-sem',
      total_stock_available: 0,
      walkin_sellable: false,
      walkin_block_reason: 'walkin_measure_not_found',
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('commerce.products');
    expect(String(query.mock.calls[0]?.[0])).not.toContain('commerce.product_full');
    expect(String(query.mock.calls[1]?.[0])).toContain('commerce.wholesale_stock');
  });
});
