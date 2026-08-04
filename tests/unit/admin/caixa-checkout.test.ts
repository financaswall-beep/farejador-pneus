import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ registerWalkinOrder: vi.fn() }));

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/admin/painel/walkin-order.js', () => ({
  registerWalkinOrder: mocks.registerWalkinOrder,
}));

let getCaixaCatalog: typeof import('../../../src/admin/caixa/checkout.js').getCaixaCatalog;
let createCaixaSale: typeof import('../../../src/admin/caixa/checkout.js').createCaixaSale;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'emergency-token',
    MATRIZ_CENTRAL_LEDGER: 'true',
    MATRIZ_CENTRAL_LEDGER_READ: 'true',
  });
  ({ getCaixaCatalog, createCaixaSale } = await import('../../../src/admin/caixa/checkout.js'));
});

describe('checkout integrado do Frente de Caixa', () => {
  it('lista preço da Matriz e saldo do galpão, preservando serviço sem estoque', async () => {
    const tireId = '11111111-1111-4111-8111-111111111111';
    const serviceId = '22222222-2222-4222-8222-222222222222';
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM commerce.products p')) return { rows: [
        {
          product_id: tireId, product_code: 'P-90', product_name: 'Technic City',
          product_type: 'tire', brand: 'Technic', tire_condition: 'novo',
          tire_size: '90/90-18', price_amount: '89.00', currency: 'BRL', image_url: null,
        },
        {
          product_id: serviceId, product_code: 'S-MONT', product_name: 'Montagem',
          product_type: 'service', brand: null, tire_condition: null,
          tire_size: null, price_amount: '35.00', currency: 'BRL', image_url: null,
        },
      ] };
      if (sql.includes('FROM commerce.wholesale_stock')) return { rows: [{
        measure: '90/90-18', brand: 'Technic', tire_condition: 'novo',
        quantity_on_hand: 4, unit_cost: '40.00',
      }] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const pool = { query } as unknown as Pool;

    const result = await getCaixaCatalog('test', '', 'all', pool);

    expect(result.products).toEqual(expect.arrayContaining([
      expect.objectContaining({ product_id: tireId, price_amount: 89, stock_quantity: 4, sellable: true }),
      expect.objectContaining({ product_id: serviceId, price_amount: 35, stock_quantity: null, sellable: true }),
    ]));
    expect(String(query.mock.calls[0]?.[0])).toContain('commerce.matriz_current_prices');
    expect(String(query.mock.calls[0]?.[0])).toContain('commerce.product_media');
  });

  it('resolve preço, vendedor e origem no servidor antes de chamar a venda atômica', async () => {
    const productId = '33333333-3333-4333-8333-333333333333';
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM commerce.products') && !sql.includes('matriz_current_prices')) {
        return { rows: [{ id: productId, product_type: 'tire' }] };
      }
      if (sql.includes('FROM commerce.matriz_current_prices')) return { rows: [{
        product_id: productId, price_amount: '129.90', price_type: 'matriz', currency: 'BRL',
      }] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const pool = { query } as unknown as Pool;
    mocks.registerWalkinOrder.mockResolvedValueOnce({ order_id: 'order-1' });

    const result = await createCaixaSale('test', {
      personId: 'person-1', collaboratorId: 'seller-1', displayName: 'Ana Souza', username: 'ana',
    }, {
      customer_name: null,
      customer_phone: null,
      payment_method: 'pix',
      idempotency_key: 'caixa-12345678',
      items: [{ product_id: productId, quantity: 2 }],
    }, pool);

    expect(result).toEqual({ order_id: 'order-1' });
    expect(mocks.registerWalkinOrder).toHaveBeenCalledWith(expect.objectContaining({
      customer_name: 'Cliente Balcão',
      seller_collaborator_id: 'seller-1',
      actor_label: 'Caixa: Ana Souza (ana)',
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'walkin_balcao',
      items: [{ product_id: productId, quantity: 2, unit_price: 129.9, discount_amount: 0 }],
    }), pool);
  });
});
