import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ matrizStock: vi.fn() }));

vi.mock('../../../src/shared/config/env.js', () => ({
  env: {
    ROUTING_MATRIZ_AS_STORE: true,
    ROUTING_MATRIZ_COMPETES: false,
    ROUTING_PROXIMITY_FIRST: true,
    ROUTING_GEO_ROAD_DISTANCE: false,
    WHOLESALE_UNIFIED_STOCK: true,
  },
}));
vi.mock('../../../src/atendente-v2/wholesale-stock-read.js', () => ({
  getMatrizWholesaleStockQty: mocks.matrizStock,
}));
vi.mock('../../../src/parceiro/queries.js', () => ({
  upsertPartnerCustomerWithClient: vi.fn(),
}));

import {
  decideStoreForItemsGeo,
  MATRIZ_COORD,
} from '../../../src/atendente-v2/fulfillment.js';

describe('roteamento de foto para a Matriz', () => {
  beforeEach(() => mocks.matrizStock.mockReset());

  it('distingue Matriz com estoque do fallback sem estoque', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as PoolClient;
    mocks.matrizStock.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const input = {
      municipio: 'São Gonçalo',
      items: [{ product_id: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
      modalidade: 'pickup' as const,
      customerLocation: MATRIZ_COORD,
      clientNeighborhoodCanonical: 'porto-da-pedra',
    };

    await expect(decideStoreForItemsGeo(client, 'prod', input))
      .resolves.toEqual({ kind: 'matriz', canFulfill: true });
    await expect(decideStoreForItemsGeo(client, 'prod', input))
      .resolves.toEqual({ kind: 'matriz', canFulfill: false });
    expect(mocks.matrizStock).toHaveBeenNthCalledWith(
      1, client, 'prod', input.items[0].product_id,
    );
  });
});
