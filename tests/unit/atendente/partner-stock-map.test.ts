import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

vi.mock('../../../src/shared/config/env.js', () => ({
  env: {
    ROUTING_MATRIZ_AS_STORE: true, ROUTING_MATRIZ_COMPETES: false,
    ROUTING_PROXIMITY_FIRST: false, ROUTING_GEO_ROAD_DISTANCE: false,
    WHOLESALE_UNIFIED_STOCK: true,
  },
}));
vi.mock('../../../src/parceiro/queries.js', () => ({
  upsertPartnerCustomerWithClient: vi.fn(),
}));
vi.mock('../../../src/atendente-v2/wholesale-stock-read.js', () => ({
  getMatrizWholesaleStockQty: vi.fn(),
}));

import {
  getPartnerStockMap,
  mapProductToPartnerStock,
} from '../../../src/atendente-v2/fulfillment.js';

describe('saldo do parceiro exposto ao bot', () => {
  it('usa o maior disponível quando um produto possui mais de uma linha', async () => {
    const query = async (sql: string) => {
      if (sql.includes('FROM network.unit_coverage')) {
        return { rows: [{
          partner_unit_id: 'partner-unit', unit_id: 'unit-a', partner_id: 'partner-a',
          slug: 'loja-a', partner_name: 'Parceiro A', unit_name: 'Loja A',
        }] };
      }
      return { rows: [
        { product_id: 'product-a', disponivel: '2' },
        { product_id: 'product-a', disponivel: '7' },
      ] };
    };
    const client = { query } as unknown as PoolClient;
    const result = await getPartnerStockMap(client, 'test', 'Itaboraí');
    expect(result.get('product-a')).toBe(7);
  });

  it('consulta somente o produto e a unidade escolhida, descontando reservas', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM commerce.partner_stock_levels')) {
        return { rowCount: 1, rows: [{ id: 'stock-a', item_name: '90/90-18 Pirelli' }] };
      }
      if (sql.includes('FROM commerce.product_prices')) {
        return { rowCount: 1, rows: [{ price_amount: '149.90' }] };
      }
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const client = { query } as unknown as PoolClient;

    const result = await mapProductToPartnerStock(
      client, 'test', 'unit-a', 'product-a', 3,
    );

    expect(result).toEqual({
      partner_stock_id: 'stock-a', central_price: 149.9, item_name: '90/90-18 Pirelli',
    });
    const [stockSql, stockParams] = query.mock.calls[0]!;
    expect(stockSql).toContain('unit_id = $2');
    expect(stockSql).toContain('product_id = $3');
    expect(stockSql).toContain('tire_condition IS NOT NULL');
    expect(stockSql).toContain('deleted_at IS NULL');
    expect(stockSql).toContain('is_tracked = true');
    expect(stockSql).toContain('(quantity_on_hand - COALESCE(quantity_reserved, 0)) >= $4');
    expect(stockParams).toEqual(['test', 'unit-a', 'product-a', 3]);
  });

  it('não oferece o pneu quando o disponível da unidade não cobre a quantidade', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const client = { query } as unknown as PoolClient;

    await expect(mapProductToPartnerStock(
      client, 'test', 'unit-a', 'product-a', 2,
    )).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
