import { z } from 'zod';

export const orderItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  discount_amount: z.number().nonnegative().optional(),
});

// S6 da auditoria 2026-05-21: pedido de entrega exige endereco.
export const requireDeliveryAddress = (data: { fulfillment_mode: string; delivery_address?: string | null }): boolean =>
  data.fulfillment_mode !== 'delivery' || !!(data.delivery_address && data.delivery_address.trim().length > 0);
export const deliveryAddressRefineOpts = {
  message: 'delivery_address obrigatorio quando fulfillment_mode=delivery',
  path: ['delivery_address'] as (string | number)[],
};

export const registerManualOrderSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  contact_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid(),
  draft_id: z.string().uuid().nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  payment_due_on: z.string().date().nullable().optional(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  idempotency_key: z.string().min(8),
  source_tag: z.enum(['chatwoot_com_bot', 'chatwoot_sem_bot']).nullable().optional(),
}).refine(requireDeliveryAddress, deliveryAddressRefineOpts)
  .refine((data) => data.payment_method?.trim().toLowerCase() !== 'a receber'
    || Boolean(data.payment_due_on), {
    message: 'payment_due_on_required', path: ['payment_due_on'],
  });

export const registerWalkinOrderSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  customer_name: z.string().min(1).max(200).nullable().optional(),
  customer_phone: z.string().min(1).max(40).nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  payment_due_on: z.string().date().nullable().optional(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  idempotency_key: z.string().min(8),
  source_tag: z.enum(['walkin_balcao', 'walkin_telefone', 'walkin_outro']),
}).refine(requireDeliveryAddress, deliveryAddressRefineOpts)
  .refine((data) => data.payment_method?.trim().toLowerCase() !== 'a receber'
    || Boolean(data.payment_due_on), {
    message: 'payment_due_on_required', path: ['payment_due_on'],
  });

export const cancelParamsSchema = z.object({
  order_id: z.string().uuid(),
});

export const cancelBodySchema = z.object({
  reason: z.string().min(1).max(500),
});
