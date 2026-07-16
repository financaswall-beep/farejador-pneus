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

function salePool(sellerReady: boolean): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM commerce.tire_specs')) {
      return { rows: [{ tire_size: '90/90-18', width_mm: 90, aspect_ratio: 90, rim_diameter: 18 }] };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM audit.operation_idempotency')) return { rows: [] };
    if (sql.includes('INSERT INTO audit.operation_idempotency')) return { rows: [] };
    if (sql.includes('INSERT INTO commerce.wholesale_customers')) {
      return { rows: [{ id: 'buyer-1', name: 'Cliente' }] };
    }
    if (sql.includes('information_schema.columns')) return { rows: [{ ready: sellerReady }] };
    if (sql.includes('INSERT INTO commerce.wholesale_orders')) return { rows: [{ id: 'order-1' }] };
    if (sql.includes('SELECT quantity_on_hand,unit_cost FROM commerce.wholesale_stock')) {
      return { rows: [{ quantity_on_hand: '10', unit_cost: '20' }] };
    }
    if (sql.includes('INSERT INTO commerce.wholesale_order_items')) return { rows: [] };
    if (sql.includes("set_config('app.galpao_source'")) return { rows: [] };
    if (sql.includes('UPDATE commerce.wholesale_stock')) return { rows: [{ quantity_on_hand: 9 }] };
    if (sql.includes('UPDATE commerce.wholesale_orders')) return { rows: [{ total_amount: '50.00' }] };
    if (sql.includes('INSERT INTO audit.events')) return { rows: [] };
    if (sql.includes('UPDATE audit.operation_idempotency')) return { rows: [{ idempotency_key: 'sale-schema-test' }] };
    throw new Error(`consulta inesperada: ${sql}`);
  });
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }), query: vi.fn(),
  } as unknown as Pool;
  return { pool, query };
}

describe('compatibilidade da coluna opcional de vendedor na venda de atacado', () => {
  it('grava a venda sem a coluna opcional de vendedor', async () => {
    const { pool, query } = salePool(false);

    await expect(registerWholesaleSale({
      environment: 'test', new_customer: { name: 'Cliente' }, created_by: 'teste',
      seller_collaborator_id: '33333333-3333-4333-8333-333333333333',
      items: [{ measure: '90/90-18', quantity: 1, unit_price: 50 }],
      idempotency_key: 'sale-schema-test-1',
    }, pool)).resolves.toMatchObject({ order_id: 'order-1', total_amount: '50.00' });

    const orderInsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO commerce.wholesale_orders'))?.[0];
    expect(orderInsert).not.toContain('seller_collaborator_id');
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('tipa o ambiente explicitamente quando atribui o vendedor', async () => {
    const { pool, query } = salePool(true);

    await registerWholesaleSale({
      environment: 'test', new_customer: { name: 'Cliente' }, created_by: 'teste',
      seller_collaborator_id: '33333333-3333-4333-8333-333333333333',
      items: [{ measure: '90/90-18', quantity: 1, unit_price: 50 }],
      idempotency_key: 'sale-schema-test-2',
    }, pool);

    const orderInsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO commerce.wholesale_orders'))?.[0];
    expect(orderInsert).toContain('$1::env_t');
  });
});
