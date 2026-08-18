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

import { getPartnerStockMap } from '../../../src/atendente-v2/fulfillment.js';

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
});
