import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setCatalogPrice: vi.fn() }));

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/admin/painel/queries-catalogo.js', () => ({
  setCatalogPrice: mocks.setCatalogPrice,
}));

let getMatrizOperationStock:
  typeof import('../../../src/admin/caixa/operation-stock.js').getMatrizOperationStock;
let setMatrizOperationStockPrice:
  typeof import('../../../src/admin/caixa/operation-stock.js').setMatrizOperationStockPrice;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  ({ getMatrizOperationStock, setMatrizOperationStockPrice } = await import(
    '../../../src/admin/caixa/operation-stock.js'
  ));
});

beforeEach(() => mocks.setCatalogPrice.mockReset());

function matrixPool(withCatalog = true): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM commerce.wholesale_stock')) return { rows: [{
      id: '11111111-1111-4111-8111-111111111111', measure: '90/90-18',
      brand: 'Técnic', tire_condition: 'meia_vida', quantity_on_hand: 8,
      quantity_reserved: 2, quantity_available: 6, min_quantity: 2,
      updated_at: '2026-08-20T12:00:00Z', tire_width_mm: 90,
      tire_aspect_ratio: 90, tire_rim_diameter: 18,
    }] };
    if (sql.includes('FROM commerce.products p')) return { rows: withCatalog ? [{
      product_id: '22222222-2222-4222-8222-222222222222', tire_size: '90/90R18',
      brand: 'Tecnic', tire_condition: 'meia_vida', sale_price: '150.00',
    }] : [] };
    throw new Error(`consulta inesperada: ${sql}`);
  });
  return { query } as unknown as Pool;
}

describe('preço oficial da Matriz no estoque da Operação', () => {
  it('casa medida e marca normalizadas sem expor custo e mantém saldo somente leitura', async () => {
    const result = await getMatrizOperationStock(matrixPool());
    expect(result).toMatchObject({ readonly: true, stock_readonly: true });
    expect(result.rows[0]).toMatchObject({
      product_id: '22222222-2222-4222-8222-222222222222', sale_price: 150,
      quantity_on_hand: 8, quantity_reserved: 2, quantity_available: 6,
    });
    expect(result.rows[0]).not.toHaveProperty('average_cost');
  });

  it('reutiliza a troca auditada do Catálogo e recusa ficha sem produto inequívoco', async () => {
    mocks.setCatalogPrice.mockResolvedValueOnce({ changed: true, price_id: 'price-1', price_amount: 139.9 });
    await expect(setMatrizOperationStockPrice(
      '11111111-1111-4111-8111-111111111111', 139.9, 'negociação da tabela',
      'Caixa: Dona', matrixPool(),
    )).resolves.toEqual({
      changed: true, stock_id: '11111111-1111-4111-8111-111111111111', sale_price: 139.9,
    });
    expect(mocks.setCatalogPrice).toHaveBeenCalledWith(expect.objectContaining({
      productId: '22222222-2222-4222-8222-222222222222', priceAmount: 139.9,
      reason: 'negociação da tabela', actorLabel: 'Caixa: Dona', environment: 'test',
    }), expect.anything());

    await expect(setMatrizOperationStockPrice(
      '11111111-1111-4111-8111-111111111111', 139.9, 'tabela', 'Caixa: Dona', matrixPool(false),
    )).rejects.toMatchObject({ code: 'catalog_product_not_found', status: 409 });
  });
});
