import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: vi.fn(async (
    _partnerUnitId: string,
    callback: (client: { query: typeof mocks.query }) => Promise<unknown>,
  ) => callback({ query: mocks.query })),
}));

import {
  OperationStockPriceError,
  setPartnerOperationStockPrice,
} from '../../../src/parceiro/operation-stock-price.js';

const ctx: PartnerContext = {
  environment: 'test', partnerId: 'partner-a', partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a', slug: 'loja-a', partnerName: 'Parceiro A',
  unitName: 'Unidade A', role: 'owner', tokenId: 'owner-token',
};

beforeEach(() => mocks.query.mockReset());

describe('preço oficial do estoque do parceiro', () => {
  it('altera apenas sale_price e registra antes, depois e motivo', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ sale_price: '150.00', item_name: 'Pneu A' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(setPartnerOperationStockPrice(
      ctx, 'Dona Maria', '11111111-1111-4111-8111-111111111111', 139.9, 'desconto de tabela',
    )).resolves.toEqual({
      changed: true, stock_id: '11111111-1111-4111-8111-111111111111', sale_price: 139.9,
    });

    const updateSql = String(mocks.query.mock.calls[1]?.[0]);
    expect(updateSql).toContain('SET sale_price=$4');
    expect(updateSql).not.toContain('quantity_on_hand');
    expect(updateSql).not.toContain('average_cost');
    expect(String(mocks.query.mock.calls[2]?.[0])).toContain('partner_stock_sale_price_changed');
    expect(String(mocks.query.mock.calls[2]?.[1]?.[3])).toContain('150');
    expect(String(mocks.query.mock.calls[2]?.[1]?.[4])).toContain('desconto de tabela');
  });

  it('é idempotente quando o preço em centavos já é o mesmo', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ sale_price: '139.90', item_name: 'Pneu A' }],
    });
    await expect(setPartnerOperationStockPrice(
      ctx, 'Dona Maria', '11111111-1111-4111-8111-111111111111', 139.9, 'sem mudança',
    )).resolves.toMatchObject({ changed: false, sale_price: 139.9 });
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it('recusa zero, milésimos e item fora da unidade', async () => {
    for (const value of [0, -1, 12.345]) {
      await expect(setPartnerOperationStockPrice(
        ctx, 'Dona Maria', '11111111-1111-4111-8111-111111111111', value, 'inválido',
      )).rejects.toMatchObject<Partial<OperationStockPriceError>>({
        code: 'stock_sale_price_invalid', status: 400,
      });
    }
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(setPartnerOperationStockPrice(
      ctx, 'Dona Maria', '22222222-2222-4222-8222-222222222222', 100, 'tabela nova',
    )).rejects.toMatchObject({ code: 'stock_not_found', status: 404 });
  });
});
