import { describe, expect, it } from 'vitest';
import {
  partnerPurchaseSchema, partnerPurchaseTotalCents, sixDecimalCostSchema,
} from '../../../src/parceiro/purchase-schema.js';

const purchase = {
  supplier_name: 'Fornecedor',
  payment_status: 'paid_now' as const,
  idempotency_key: 'purchase-12345678',
  items: [{
    item_name: 'Pneu 90/90-18', tire_condition: 'novo' as const,
    quantity: 3, unit_cost: 100.25, sale_price: 149.9,
  }],
};

describe('contrato monetário da compra do parceiro', () => {
  it('aceita somente valores representáveis em centavos', () => {
    expect(partnerPurchaseSchema.safeParse(purchase).success).toBe(true);
    expect(partnerPurchaseSchema.safeParse({
      ...purchase, items: [{ ...purchase.items[0], unit_cost: 0.335 }],
    }).success).toBe(false);
    expect(partnerPurchaseSchema.safeParse({
      ...purchase, items: [{ ...purchase.items[0], sale_price: 149.999 }],
    }).success).toBe(false);
  });

  it('exige chave idempotente e vencimento em compra a prazo', () => {
    const { idempotency_key: _ignored, ...withoutKey } = purchase;
    expect(partnerPurchaseSchema.safeParse(withoutKey).success).toBe(false);
    expect(partnerPurchaseSchema.safeParse({
      ...purchase, payment_status: 'payable', payable_due_date: null,
    }).success).toBe(false);
    expect(partnerPurchaseSchema.safeParse({
      ...purchase, payment_status: 'payable', payable_due_date: '2026-08-25',
    }).success).toBe(true);
  });

  it('fecha o total em centavos e recusa estouro do cabeçalho', () => {
    expect(partnerPurchaseTotalCents([
      { quantity: 3, unit_cost: 19.99 },
      { quantity: 2, unit_cost: 0.10 },
    ])).toBe(6_017);
    expect(() => partnerPurchaseTotalCents([
      { quantity: 999_999, unit_cost: 99_999_999.99 },
    ])).toThrow('purchase_line_total_too_large');
  });

  it('preserva custo médio derivado com seis casas', () => {
    expect(sixDecimalCostSchema.safeParse(100.004).success).toBe(true);
    expect(sixDecimalCostSchema.safeParse(100.0040004).success).toBe(false);
  });

  it('recusa compra futura e vencimento anterior à compra', () => {
    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    expect(partnerPurchaseSchema.safeParse({ ...purchase, purchased_at: future }).success)
      .toBe(false);
    expect(partnerPurchaseSchema.safeParse({
      ...purchase, payment_status: 'payable', purchased_at: '2026-08-17T12:00:00.000Z',
      payable_due_date: '2026-08-16',
    }).success).toBe(false);
  });
});
