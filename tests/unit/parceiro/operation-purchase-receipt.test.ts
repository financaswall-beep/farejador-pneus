import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  applyStock: vi.fn(),
}));

vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: async (
    _partnerUnitId: string,
    callback: (client: { query: typeof mocks.query }) => Promise<unknown>,
  ) => callback({ query: mocks.query }),
}));

vi.mock('../../../src/parceiro/purchase-receipt-stock.js', () => ({
  applyPurchaseReceiptStock: mocks.applyStock,
}));

import {
  getOperationPendingPurchases,
  OperationPurchaseReceiptError,
  receiveOperationPurchase,
} from '../../../src/parceiro/operation-purchase-receipt.js';

const ctx: PartnerContext = {
  environment: 'test', partnerId: 'partner-a', partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a', slug: 'loja-a', partnerName: 'Parceiro A',
  unitName: 'Unidade A', role: 'funcionario', tokenId: 'token-a',
};

const purchaseItem = {
  id: '10000000-0000-4000-8000-000000000001',
  product_id: null,
  item_name: 'Maggion Matrix',
  quantity: 4,
  unit_cost: '120.00',
  tire_size: '90/90-18',
  tire_width_mm: 90,
  tire_aspect_ratio: 90,
  tire_rim_diameter: 18,
  brand: 'Maggion',
  sale_price: '199.90',
  tire_condition: 'novo',
};

beforeEach(() => {
  mocks.query.mockReset();
  mocks.applyStock.mockReset();
});

describe('recebimento de compra pela Operação da Loja', () => {
  it('lista somente dados operacionais da unidade, sem custo nem preço', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      purchase_id: 'purchase-a', supplier_name: 'Distribuidora',
      purchased_at: '2026-08-11T10:00:00Z', created_at: '2026-08-11T10:00:00Z',
      item_id: purchaseItem.id, item_name: purchaseItem.item_name,
      tire_size: purchaseItem.tire_size, brand: purchaseItem.brand,
      tire_condition: purchaseItem.tire_condition, expected_quantity: 4,
    }] });

    await expect(getOperationPendingPurchases(ctx)).resolves.toMatchObject({
      rows: [{ purchase_id: 'purchase-a', items: [{ expected_quantity: 4 }] }],
    });
    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain("p.receipt_status='pending'");
    expect(sql).toContain('p.environment=$1 AND p.unit_id=$2');
    expect(sql).not.toContain('unit_cost');
    expect(sql).not.toContain('sale_price');
    expect(sql).not.toContain('total_amount');
    expect(sql).not.toContain('payment_method');
  });

  it('confirma uma vez, atualiza os itens e audita a entrada', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        id: 'purchase-a', supplier_name: 'Distribuidora', receipt_status: 'pending',
        receipt_idempotency_key: null, received_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [purchaseItem] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ received_at: '2026-08-11T12:00:00Z' }] })
      .mockResolvedValueOnce({});
    mocks.applyStock.mockResolvedValueOnce({
      stock_id: 'stock-a', item_id: purchaseItem.id,
      received_quantity: 4, new_qty: 9, new_status: 'in_stock',
    });

    await expect(receiveOperationPurchase(ctx, 'Wallace', 'purchase-a', {
      idempotency_key: 'receipt-12345678',
      items: [{ item_id: purchaseItem.id, received_quantity: 4 }],
    })).resolves.toMatchObject({
      purchase_id: 'purchase-a', received: true, idempotent: false,
      has_divergence: false, expected_units: 4, received_units: 4,
    });

    expect(mocks.applyStock).toHaveBeenCalledOnce();
    const sql = mocks.query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('SET received_quantity=$4');
    expect(sql).toContain("SET receipt_status='received'");
    expect(sql).toContain('receipt_idempotency_key=$6');
    expect(sql).toContain("'stock_increment_purchase'");
  });

  it('repete a mesma confirmação sem movimentar estoque novamente', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: 'purchase-a', supplier_name: 'Distribuidora', receipt_status: 'received',
      receipt_idempotency_key: 'receipt-12345678', received_at: '2026-08-11T12:00:00Z',
    }] });

    await expect(receiveOperationPurchase(ctx, 'Wallace', 'purchase-a', {
      idempotency_key: 'receipt-12345678',
      items: [{ item_id: purchaseItem.id, received_quantity: 4 }],
    })).resolves.toMatchObject({ received: true, idempotent: true });
    expect(mocks.applyStock).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it('recusa item diferente do documento de compra', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        id: 'purchase-a', supplier_name: null, receipt_status: 'pending',
        receipt_idempotency_key: null, received_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [purchaseItem] });

    await expect(receiveOperationPurchase(ctx, 'Wallace', 'purchase-a', {
      idempotency_key: 'receipt-87654321',
      items: [{ item_id: '20000000-0000-4000-8000-000000000002', received_quantity: 4 }],
    })).rejects.toMatchObject<Partial<OperationPurchaseReceiptError>>({
      code: 'purchase_items_mismatch', status: 409,
    });
    expect(mocks.applyStock).not.toHaveBeenCalled();
  });
});
