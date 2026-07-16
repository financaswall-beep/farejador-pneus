import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

let registerManualOrder: typeof import('../../../src/admin/painel/queries-pedidos-acoes.js').registerManualOrder;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    WHOLESALE_MATRIZ_RETAIL_COST: 'false', WHOLESALE_MATRIZ_DECREMENT: 'false',
  });
  ({ registerManualOrder } = await import('../../../src/admin/painel/queries-pedidos-acoes.js'));
});

const input = {
  environment: 'test' as const,
  conversation_id: '11111111-1111-4111-8111-111111111111',
  items: [{ product_id: '22222222-2222-4222-8222-222222222222', quantity: 1, unit_price: 100 }],
  payment_method: 'pix', fulfillment_mode: 'pickup' as const,
  actor_label: 'teste', seller_collaborator_id: '33333333-3333-4333-8333-333333333333',
  idempotency_key: 'teste-atomicidade',
};

describe('atribuicao atomica do vendedor ao pedido', () => {
  it('faz rollback do pedido quando o vendedor nao existe', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM core.conversations')) return { rows: [{ contact_id: 'contact-1' }] };
      if (sql.includes('commerce.register_manual_order')) return { rows: [{ order_id: 'order-1' }] };
      if (sql.includes('information_schema.columns')) return { rows: [{ ready: true }] };
      if (sql.includes('UPDATE commerce.orders')) return { rows: [] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }), query: vi.fn() } as unknown as Pool;

    await expect(registerManualOrder(input, pool)).rejects.toThrow('seller_collaborator_not_found');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('confirma pedido e vendedor na mesma transacao', async () => {
    const query = vi.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM core.conversations')) return { rows: [{ contact_id: 'contact-1' }] };
      if (sql.includes('commerce.register_manual_order')) return { rows: [{ order_id: 'order-1' }] };
      if (sql.includes('information_schema.columns')) return { rows: [{ ready: true }] };
      if (sql.includes('UPDATE commerce.orders')) return { rows: [{ id: 'order-1' }] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }), query: vi.fn(),
    } as unknown as Pool;

    await expect(registerManualOrder(input, pool)).resolves.toEqual({ order_id: 'order-1' });
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('mantem a venda viva durante deploy anterior a migration 0133', async () => {
    const query = vi.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM core.conversations')) return { rows: [{ contact_id: 'contact-1' }] };
      if (sql.includes('commerce.register_manual_order')) return { rows: [{ order_id: 'order-1' }] };
      if (sql.includes('information_schema.columns')) return { rows: [{ ready: false }] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }), query: vi.fn(),
    } as unknown as Pool;

    await expect(registerManualOrder(input, pool)).resolves.toEqual({ order_id: 'order-1' });
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE commerce.orders'))).toBe(false);
  });
});
