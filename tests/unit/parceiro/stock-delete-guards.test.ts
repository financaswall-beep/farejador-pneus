import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: async (
    _partnerUnitId: string,
    callback: (client: { query: typeof query }) => Promise<unknown>,
  ) => callback({ query }),
}));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../../src/shared/config/env.js', () => ({
  env: { FAREJADOR_ENV: 'test', NODE_ENV: 'test' },
}));

import {
  deletePartnerStock, StockPositiveCannotDeleteError, StockReservedCannotDeleteError,
} from '../../../src/parceiro/queries.js';

const ctx: PartnerContext = {
  environment: 'test', partnerId: 'partner-a', partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a', slug: 'loja-a', partnerName: 'Parceiro A', unitName: 'Unidade A',
  role: 'dono', tokenId: 'token-a',
};

beforeEach(() => query.mockReset());

describe('inativação segura do estoque parceiro', () => {
  it('bloqueia item com saldo físico', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 'stock-a', item_name: 'Pneu', quantity_on_hand: 3, quantity_reserved: 0,
    }] });
    await expect(deletePartnerStock(ctx, 'stock-a')).rejects
      .toBeInstanceOf(StockPositiveCannotDeleteError);
    expect(query).toHaveBeenCalledOnce();
  });

  it('prioriza o bloqueio de reserva aberta', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 'stock-a', item_name: 'Pneu', quantity_on_hand: 3, quantity_reserved: 1,
    }] });
    await expect(deletePartnerStock(ctx, 'stock-a')).rejects
      .toBeInstanceOf(StockReservedCannotDeleteError);
    expect(query).toHaveBeenCalledOnce();
  });
});
