import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

let registerWholesaleSale: typeof import('../../../src/admin/painel/queries-atacado-vendas.js').registerWholesaleSale;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    WHOLESALE_FINANCE: 'false', WHOLESALE_STOCK_DECREMENT: 'false',
  });
  ({ registerWholesaleSale } = await import('../../../src/admin/painel/queries-atacado-vendas.js'));
});

describe('compatibilidade da venda de atacado antes da migration 0133', () => {
  it('grava a venda sem a coluna opcional de vendedor', async () => {
    const query = vi.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT'].includes(sql)) return { rows: [] };
      if (sql.includes('INSERT INTO commerce.wholesale_customers')) return { rows: [{ id: 'buyer-1', name: 'Cliente' }] };
      if (sql.includes('information_schema.columns')) return { rows: [{ ready: false }] };
      if (sql.includes('INSERT INTO commerce.wholesale_orders')) return { rows: [{ id: 'order-1' }] };
      if (sql.includes('FROM commerce.wholesale_stock')) return { rows: [{ quantity_on_hand: '10', unit_cost: '20' }] };
      if (sql.includes('INSERT INTO commerce.wholesale_order_items')) return { rows: [] };
      if (sql.includes('UPDATE commerce.wholesale_orders')) return { rows: [{ total_amount: '50.00' }] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }), query: vi.fn(),
    } as unknown as Pool;

    await expect(registerWholesaleSale({
      environment: 'test', new_customer: { name: 'Cliente' }, created_by: 'teste',
      seller_collaborator_id: '33333333-3333-4333-8333-333333333333',
      items: [{ measure: '90/90-18', quantity: 1, unit_price: 50 }],
    }, pool)).resolves.toMatchObject({ order_id: 'order-1', total_amount: '50.00' });

    const orderInsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO commerce.wholesale_orders'))?.[0];
    expect(orderInsert).not.toContain('seller_collaborator_id');
    expect(query).toHaveBeenCalledWith('COMMIT');
  });
});
