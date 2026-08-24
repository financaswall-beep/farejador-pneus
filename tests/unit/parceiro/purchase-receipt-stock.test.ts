import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';
import { applyPurchaseReceiptStock } from '../../../src/parceiro/purchase-receipt-stock.js';

const ctx: PartnerContext = {
  environment: 'test', partnerId: 'partner-a', partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a', slug: 'loja-a', partnerName: 'Parceiro A', unitName: 'Loja A',
  role: 'owner', tokenId: 'owner-token',
};

const item = {
  id: 'item-a', product_id: 'product-a', item_name: 'Pneu 90/90-18', quantity: 2,
  unit_cost: 45, tire_size: '90/90-18', tire_width_mm: 90,
  tire_aspect_ratio: 90, tire_rim_diameter: 18, brand: 'Levorin',
  sale_price: 89, tire_condition: 'meia_vida' as const,
};

describe('recebimento de compra atualiza preço somente quando ele foi informado', () => {
  it('aplica o novo preço informado pela compra ao incrementar uma linha existente', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        stock_id: 'stock-a', quantity_on_hand: 3, average_cost: '40.00',
      }] })
      .mockResolvedValueOnce({ rows: [{
        stock_id: 'stock-a', new_qty: 5, new_average_cost: '42.00', new_status: 'ok',
      }] });

    await expect(applyPurchaseReceiptStock(
      { query } as unknown as PoolClient, ctx, item, 2, 'Fornecedor', 'Dona Maria',
    )).resolves.toMatchObject({ stock_id: 'stock-a', previous_qty: 3, new_qty: 5 });

    const updateSql = String(query.mock.calls[2]?.[0]);
    expect(updateSql).toContain('sale_price=COALESCE($6,sale_price)');
    expect(query.mock.calls[2]?.[1]?.[5]).toBe(89);
  });

  it('preserva o preço atual quando a compra não informa um novo preço', async () => {
    const withoutPrice = { ...item, sale_price: null };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        stock_id: 'stock-a', quantity_on_hand: 3, average_cost: '40.00',
      }] })
      .mockResolvedValueOnce({ rows: [{
        stock_id: 'stock-a', new_qty: 5, new_average_cost: '42.00', new_status: 'ok',
      }] });

    await applyPurchaseReceiptStock(
      { query } as unknown as PoolClient, ctx, withoutPrice, 2, 'Fornecedor', 'Dona Maria',
    );
    expect(String(query.mock.calls[2]?.[0])).toContain('sale_price=COALESCE($6,sale_price)');
    expect(query.mock.calls[2]?.[1]?.[5]).toBeNull();
  });

  it('usa o preço da compra ao criar uma linha nova', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        stock_id: 'stock-new', new_qty: 2, new_average_cost: '45.00', new_status: 'ok',
      }] });

    await applyPurchaseReceiptStock(
      { query } as unknown as PoolClient, ctx, item, 2, 'Fornecedor', 'Dona Maria',
    );
    const insertSql = String(query.mock.calls[2]?.[0]);
    expect(insertSql).toContain('average_cost, sale_price, tire_condition');
    expect(query.mock.calls[2]?.[1]?.[12]).toBe(89);
  });
});
