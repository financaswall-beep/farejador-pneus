/**
 * Testes do Zod schema do endpoint de venda do parceiro — S6 da auditoria 2026-05-21.
 *
 * Validacao cruzada: fulfillment_mode='delivery' exige delivery_address nao-vazio.
 *
 * Como o schema mora dentro de route.ts (nao exportado), criamos uma copia
 * minima reproduzindo as mesmas regras pra testar a logica do refine sem
 * subir Fastify.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Re-implementacao minima do refine, identica ao route.ts
const orderItemSchema = z.object({
  partner_stock_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
});

const saleSchema = z.object({
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  idempotency_key: z.string().min(8),
}).refine(
  (data) => data.fulfillment_mode !== 'delivery' || (data.delivery_address && data.delivery_address.trim().length > 0),
  {
    message: 'delivery_address obrigatorio quando fulfillment_mode=delivery',
    path: ['delivery_address'],
  },
);

const validItem = {
  partner_stock_id: '00000000-0000-0000-0000-000000000001',
  quantity: 1,
  unit_price: 100,
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
      payment_method: 'pix',
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
});
