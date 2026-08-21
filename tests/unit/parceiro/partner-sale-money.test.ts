import { describe, expect, it } from 'vitest';
import { partnerSaleTotalCents } from '../../../src/parceiro/partner-sale-pricing.js';
import { partnerSaleSchema } from '../../../src/parceiro/sale-schema.js';

const base = {
  customer_name: 'Cliente',
  items: [{
    partner_stock_id: '11111111-1111-4111-8111-111111111111',
    quantity: 2,
    unit_price: 45.01,
    reference_unit_price: 50,
  }],
  payment_method: 'Pix',
  payment_status: 'received' as const,
  received_amount: 90.02,
  fulfillment_mode: 'pickup' as const,
  idempotency_key: 'sale-money-test',
};

describe('matemática da venda do parceiro', () => {
  it('calcula em centavos com desconto negociado e frete', () => {
    expect(partnerSaleTotalCents([
      { quantity: 2, unit_price: 45.01, discount_amount: 0.02 },
      { quantity: 1, unit_price: 45 },
    ], 5, 10)).toBe(14_000);
  });

  it('recusa desconto maior que a linha e total zerado', () => {
    expect(() => partnerSaleTotalCents([
      { quantity: 1, unit_price: 45, discount_amount: 45.01 },
    ])).toThrow('partner_sale_item_discount_exceeds_line');
    expect(() => partnerSaleTotalCents([
      { quantity: 1, unit_price: 45 },
    ], 45)).toThrow('partner_sale_total_must_be_positive');
  });

  it('recusa terceira casa decimal e valor recebido abaixo do total', () => {
    expect(partnerSaleSchema.safeParse({ ...base, freight_amount: 0.001 }).success).toBe(false);
    const underpaid = partnerSaleSchema.safeParse({ ...base, received_amount: 90.01 });
    expect(underpaid.success).toBe(false);
    if (!underpaid.success) {
      expect(underpaid.error.issues.some(
        (issue) => issue.message === 'received_amount_below_sale_total',
      )).toBe(true);
    }
  });

  it('obriga entrega a ser recebida somente na confirmação', () => {
    const invalid = partnerSaleSchema.safeParse({
      ...base,
      fulfillment_mode: 'delivery',
      delivery_address: 'Rua 1',
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.some(
        (issue) => issue.message === 'partner_delivery_must_be_cash_on_delivery',
      )).toBe(true);
    }
    expect(partnerSaleSchema.safeParse({
      ...base,
      fulfillment_mode: 'delivery',
      delivery_address: 'Rua 1',
      payment_method: 'A receber',
      payment_status: 'receivable',
      received_amount: null,
    }).success).toBe(true);
  });
});
