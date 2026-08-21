import { z } from 'zod';
import { centMoneySchema } from './purchase-schema.js';
import { partnerSaleTotalCents } from './partner-sale-pricing.js';

// Cada item aponta direto para o estoque local; o preço cobrado pode ser
// negociado, mas o total inteiro precisa continuar exato e positivo.
export const partnerSaleItemSchema = z.object({
  partner_stock_id: z.string().uuid(),
  quantity: z.number().int().positive().max(999_999),
  unit_price: centMoneySchema.refine((value) => value > 0, 'sale_price_must_be_positive'),
  reference_unit_price: centMoneySchema.refine(
    (value) => value > 0, 'sale_price_must_be_positive',
  ).optional(),
  discount_amount: centMoneySchema.optional(),
});

export const partnerSaleSchema = z.object({
  customer_id: z.string().uuid().nullable().optional(),
  customer_name: z.string().min(1).max(200).nullable().optional(),
  customer_phone: z.string().min(1).max(40).nullable().optional(),
  customer_cpf: z.string().min(11).max(14).nullable().optional(),
  items: z.array(partnerSaleItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  payment_status: z.enum(['received', 'receivable']).nullable().optional(),
  receivable_due_date: z.string().date().nullable().optional(),
  receivable_installments: z.number().int().min(1).max(36).nullable().optional(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  received_amount: centMoneySchema.nullable().optional(),
  discount_amount: centMoneySchema.nullable().optional(),
  freight_amount: centMoneySchema.nullable().optional(),
  source_tag: z.enum(['porta', '2w', 'walkin_balcao', 'walkin_telefone', 'outro']).optional(),
  idempotency_key: z.string().min(8),
}).refine(
  (data) => data.fulfillment_mode !== 'delivery'
    || Boolean(data.delivery_address?.trim()),
  {
    message: 'delivery_address obrigatorio quando fulfillment_mode=delivery',
    path: ['delivery_address'],
  },
).refine(
  (data) => data.payment_status !== 'receivable'
    || data.fulfillment_mode === 'delivery'
    || Boolean(data.receivable_due_date?.trim()),
  {
    message: 'receivable_due_date obrigatorio quando payment_status=receivable',
    path: ['receivable_due_date'],
  },
).refine(
  // A entrega é COD. O caixa entra uma vez, somente na confirmação.
  (data) => data.fulfillment_mode !== 'delivery' || data.payment_status === 'receivable',
  {
    message: 'partner_delivery_must_be_cash_on_delivery',
    path: ['payment_status'],
  },
).superRefine((data, ctx) => {
  let totalCents: number;
  try {
    totalCents = partnerSaleTotalCents(
      data.items, data.discount_amount ?? 0, data.freight_amount ?? 0,
    );
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'partner_sale_total_invalid',
      path: ['items'],
    });
    return;
  }
  if (data.payment_status !== 'receivable' && !data.payment_method?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, message: 'payment_method_required', path: ['payment_method'],
    });
  }
  if (data.payment_status !== 'receivable' && data.received_amount != null
      && Math.round((data.received_amount + Number.EPSILON) * 100) < totalCents) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'received_amount_below_sale_total',
      path: ['received_amount'],
    });
  }
});
