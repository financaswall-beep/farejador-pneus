/**
 * Testes do Zod schema do endpoint de venda do parceiro — S6 da auditoria 2026-05-21.
 *
 * Validacao cruzada: fulfillment_mode='delivery' exige delivery_address nao-vazio.
 *
 * Testa o schema real compartilhado pelo endpoint.
 */

import { describe, expect, it } from 'vitest';
import {
  partnerSaleItemSchema as orderItemSchema,
  partnerSaleSchema as saleSchema,
} from '../../../src/parceiro/sale-schema.js';

const validItem = {
  partner_stock_id: '00000000-0000-0000-0000-000000000001',
  quantity: 1,
  unit_price: 100,
  reference_unit_price: 120,
};

describe('saleSchema — refine delivery_address (S6)', () => {
  it('aceita pickup sem delivery_address', () => {
    const r = saleSchema.safeParse({
      items: [validItem],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      idempotency_key: 'abcdefgh12',
    });
    expect(r.success).toBe(true);
  });

  it('aceita delivery com delivery_address preenchido', () => {
    const r = saleSchema.safeParse({
      items: [validItem],
      payment_method: 'A receber',
      payment_status: 'receivable',
      fulfillment_mode: 'delivery',
      delivery_address: 'Rua das Flores, 123',
      idempotency_key: 'abcdefgh12',
    });
    expect(r.success).toBe(true);
  });

  it('rejeita delivery sem delivery_address', () => {
    const r = saleSchema.safeParse({
      items: [validItem],
      payment_method: 'pix',
      fulfillment_mode: 'delivery',
      idempotency_key: 'abcdefgh12',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(['delivery_address']);
      expect(r.error.issues[0]?.message).toMatch(/delivery_address obrigatorio/);
    }
  });

  it('rejeita delivery com delivery_address apenas espacos em branco', () => {
    const r = saleSchema.safeParse({
      items: [validItem],
      payment_method: 'pix',
      fulfillment_mode: 'delivery',
      delivery_address: '   ',
      idempotency_key: 'abcdefgh12',
    });
    // O .min(1) do z.string() ja barra, antes do refine. Confirma que de algum jeito barrou.
    expect(r.success).toBe(false);
  });

  it('rejeita delivery com delivery_address null', () => {
    const r = saleSchema.safeParse({
      items: [validItem],
      payment_method: 'pix',
      fulfillment_mode: 'delivery',
      delivery_address: null,
      idempotency_key: 'abcdefgh12',
    });
    expect(r.success).toBe(false);
  });

  it('aceita preço negociado abaixo ou acima do oficial e recusa zero/milésimos', () => {
    for (const unitPrice of [90, 130]) {
      expect(orderItemSchema.safeParse({ ...validItem, unit_price: unitPrice }).success).toBe(true);
    }
    expect(orderItemSchema.safeParse({ ...validItem, unit_price: 0 }).success).toBe(false);
    expect(orderItemSchema.safeParse({ ...validItem, unit_price: 99.999 }).success).toBe(false);
  });
});
