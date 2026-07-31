import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

let getCatalogOverview: typeof import('../../../src/admin/painel/queries-catalogo.js').getCatalogOverview;
let getCatalogPriceHistory: typeof import('../../../src/admin/painel/queries-catalogo.js').getCatalogPriceHistory;
let setCatalogPrice: typeof import('../../../src/admin/painel/queries-catalogo.js').setCatalogPrice;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ getCatalogOverview, getCatalogPriceHistory, setCatalogPrice }
    = await import('../../../src/admin/painel/queries-catalogo.js'));
});

describe('catalogo conciliado com estoque e precos', () => {
  it('combina produto, preco central, custo e saldo oficial sem duplicar fonte', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM commerce.products')) return {
        rows: [{
          product_id: 'produto-1',
          product_code: 'RIN-909018',
          product_name: 'Rinaldi',
          product_type: 'tire',
          brand: 'Rinaldi',
          tire_size: '90/90-18',
          tire_position: null,
          price_amount: '139.90',
          currency: 'BRL',
          price_type: 'regular',
        }],
      };
      if (sql.includes('FROM commerce.wholesale_stock')) return {
        rows: [{
          measure: '90-90-18',
          brand: 'Rinaldi',
          quantity_on_hand: '28',
          unit_cost: '82.00',
          updated_at: '2026-07-29T14:32:00.000Z',
        }],
      };
      if (sql.includes('FROM commerce.wholesale_purchase_items')) return {
        rows: [{
          measure: '90/90-18',
          brand: 'Rinaldi',
          unit_cost: '79.50',
          purchased_at: '2026-07-28T10:00:00.000Z',
        }],
      };
      throw new Error(`consulta inesperada: ${sql}`);
    });

    const result = await getCatalogOverview('test', { query } as unknown as Pool);
    expect(result.summary).toEqual({
      products: 1, stock_only: 0, brands: 1, without_price: 0, with_stock: 1,
    });
    expect(result.rows[0]).toMatchObject({
      product_id: 'produto-1',
      official_quantity_on_hand: 28,
      official_unit_cost: 82,
      last_purchase_cost: 79.5,
      gross_profit: 57.9,
      sellable: true,
      block_reason: null,
    });
  });

  it('mostra variante com saldo ainda sem produto comercial sem liberá-la para venda', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM commerce.products')) return {
        rows: [{
          product_id: 'produto-pirelli',
          product_code: 'PIR-909018',
          product_name: 'Pirelli',
          product_type: 'tire',
          brand: 'Pirelli',
          tire_size: '90/90-18',
          tire_position: null,
          price_amount: '150.00',
          currency: 'BRL',
          price_type: 'regular',
        }],
      };
      if (sql.includes('FROM commerce.wholesale_stock')) return {
        rows: [
          {
            measure: '90/90-18', brand: 'Pirelli', quantity_on_hand: '50',
            unit_cost: '17.00', updated_at: '2026-07-30T12:00:00.000Z',
          },
          {
            measure: '90/90-18', brand: 'Metzeler', quantity_on_hand: '15',
            unit_cost: '12.00', updated_at: '2026-07-30T13:00:00.000Z',
          },
        ],
      };
      if (sql.includes('FROM commerce.wholesale_purchase_items')) return { rows: [] };
      throw new Error(`consulta inesperada: ${sql}`);
    });

    const result = await getCatalogOverview('test', { query } as unknown as Pool);
    expect(result.summary).toMatchObject({
      products: 1, stock_only: 1, brands: 2, with_stock: 2,
    });
    expect(result.rows).toContainEqual(expect.objectContaining({
      product_id: null,
      row_key: expect.stringContaining('stock:'),
      catalogued: false,
      brand: 'Metzeler',
      tire_size: '90/90-18',
      official_quantity_on_hand: 15,
      official_unit_cost: 12,
      sellable: false,
      block_reason: 'catalog_product_missing',
    }));
  });

  it('troca o preco temporalmente e registra motivo imutavel na auditoria', async () => {
    const query = vi.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM commerce.products')) return { rows: [{ id: 'produto-1' }] };
      if (sql.includes('FROM commerce.matriz_product_prices')) return {
        rows: [{ id: 'preco-antigo', price_amount: '129.90', price_type: 'regular' }],
      };
      if (sql.includes('UPDATE commerce.matriz_product_prices')) return { rows: [] };
      if (sql.includes('INSERT INTO commerce.matriz_product_prices')) return { rows: [{ id: 'preco-novo' }] };
      if (sql.includes('INSERT INTO audit.events')) return { rows: [] };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;

    await expect(setCatalogPrice({
      productId: 'produto-1',
      priceAmount: 139.9,
      reason: 'Nova tabela comercial',
      actorLabel: 'Admin Farejador',
      environment: 'test',
    }, pool)).resolves.toEqual({
      changed: true,
      price_id: 'preco-novo',
      price_amount: 139.9,
    });

    const auditCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO audit.events'));
    expect(auditCall?.[1]?.[4]).toContain('Nova tabela comercial');
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('le o historico com o tipo sintetico da Matriz', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await getCatalogPriceHistory(
      'produto-1',
      'test',
      { query } as unknown as Pool,
    );

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("'matriz'::text AS price_type");
    expect(sql).not.toContain('pp.price_type');
  });

  it('recusa alteracao sem motivo antes de abrir transacao', async () => {
    const connect = vi.fn();
    await expect(setCatalogPrice({
      productId: 'produto-1',
      priceAmount: 139.9,
      reason: ' ',
      actorLabel: 'Admin',
      environment: 'test',
    }, { connect } as unknown as Pool)).rejects.toThrow('catalog_price_reason_required');
    expect(connect).not.toHaveBeenCalled();
  });
});
