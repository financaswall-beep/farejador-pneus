import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), resolveCatalog: vi.fn() }));

vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: vi.fn(async (
    _partnerUnitId: string,
    callback: (client: { query: typeof mocks.query }) => Promise<unknown>,
  ) => callback({ query: mocks.query })),
}));
vi.mock('../../../src/parceiro/operation-stock-catalog-link.js', () => ({
  resolveCatalogProductForStock: mocks.resolveCatalog,
}));

import {
  correctSimpleOperationStockBalance,
  createSimpleOperationTire,
  getSimpleOperationStockPrices,
} from '../../../src/parceiro/operation-stock-simple.js';

const ctx: PartnerContext = {
  environment: 'test', partnerId: 'partner-a', partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a', slug: 'loja-a', partnerName: 'Parceiro A',
  unitName: 'Unidade A', role: 'owner', tokenId: 'owner-token',
};

beforeEach(() => {
  mocks.query.mockReset();
  mocks.resolveCatalog.mockReset();
});

describe('estoque simples oficial do parceiro', () => {
  it('cadastra pneu na unidade, vincula catálogo quando inequívoco e audita', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'stock-1' }] })
      .mockResolvedValueOnce({});
    mocks.resolveCatalog.mockResolvedValue('product-1');

    await expect(createSimpleOperationTire(ctx, 'Dona Maria', {
      tire_size: '110/70-17', tire_width_mm: 110, tire_aspect_ratio: 70,
      tire_rim_diameter: 17, brand: 'Pirelli', tire_condition: 'novo',
      quantity_on_hand: 5, minimum_quantity: 2, sale_price: 149.9,
    })).resolves.toEqual({ stock_id: 'stock-1', quantity_on_hand: 5, sale_price: 149.9 });

    expect(mocks.resolveCatalog).toHaveBeenCalledWith(expect.anything(), ctx, {
      item_type: 'pneu', tire_size: '110/70-17', brand: 'Pirelli', tire_condition: 'novo',
    });
    const insertSql = String(mocks.query.mock.calls[1]?.[0]);
    const insertValues = mocks.query.mock.calls[1]?.[1];
    expect(insertSql).toContain('commerce.partner_stock_status');
    expect(insertSql).toContain('average_cost,sale_price');
    expect(insertValues).toContain('unit-a');
    expect(insertValues).not.toContain('partner-b');
    expect(mocks.query.mock.calls[2]?.[1]?.[2]).toBe('stock_item_created');
  });

  it('corrige saldo diretamente, sem permitir apagar uma reserva', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      item_name: '110/70-17', item_type: 'pneu', quantity_on_hand: 5,
      quantity_reserved: 2, minimum_quantity: 1, is_tracked: true,
    }] });
    await expect(correctSimpleOperationStockBalance(
      ctx, 'Dona Maria', '11111111-1111-4111-8111-111111111111', 1,
    )).rejects.toMatchObject({ code: 'stock_balance_below_reserved', status: 409 });
    expect(mocks.query).toHaveBeenCalledOnce();

    mocks.query.mockReset();
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        item_name: '110/70-17', item_type: 'pneu', quantity_on_hand: 5,
        quantity_reserved: 2, minimum_quantity: 1, is_tracked: true,
      }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await expect(correctSimpleOperationStockBalance(
      ctx, 'Dona Maria', '11111111-1111-4111-8111-111111111111', 4,
    )).resolves.toMatchObject({ changed: true, quantity_on_hand: 4 });
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain('quantity_on_hand=$4');
    expect(mocks.query.mock.calls[2]?.[1]?.[2]).toBe('partner_stock_count_approved');
  });

  it('lista apenas id e preço local para o dono da própria unidade', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ stock_id: 'stock-1', sale_price: '139.90' }],
    });
    await expect(getSimpleOperationStockPrices(ctx)).resolves.toEqual([
      { stock_id: 'stock-1', sale_price: 139.9 },
    ]);
    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain('environment=$1 AND unit_id=$2');
    expect(sql).not.toContain('average_cost');
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(['test', 'unit-a']);
  });

  it('protege todas as rotas simples pela permissão Estoque', () => {
    const route = readFileSync(
      resolve(process.cwd(), 'src/parceiro/route-operation-stock-simple.ts'), 'utf8',
    );
    expect(route.match(/preHandler: \[requirePartnerAuth, requireScreen\('estoque'\)\]/g)).toHaveLength(3);
    expect(route).toContain('/operacao/estoque/itens');
    expect(route).toContain('/operacao/estoque/:stockId/saldo');
    expect(route).toContain('/operacao/estoque-valores');
  });
});
