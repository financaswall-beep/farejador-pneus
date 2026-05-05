import { z } from 'zod';

export const slotSourceSchema = z.enum([
  'observed',
  'inferred',
  'confirmed',
  'offered_to_client',
  'inferred_from_history',
  'inferred_from_organizadora',
]);
export type SlotSource = z.infer<typeof slotSourceSchema>;

export const staleFlagSchema = z.enum(['fresh', 'stale', 'stale_strong']);
export type StaleFlag = z.infer<typeof staleFlagSchema>;

export const slotScopeSchema = z.enum(['global', 'item']);
export type SlotScope = z.infer<typeof slotScopeSchema>;

export const sessionItemStatusSchema = z.enum([
  'aberto',
  'ofertado',
  'no_carrinho',
  'descartado',
]);
export type SessionItemStatus = z.infer<typeof sessionItemStatusSchema>;

export const sessionSlotKeySchema = z.enum([
  'nome',
  'bairro',
  'municipio',
  'forma_pagamento',
  'moto_modelo',
  'moto_ano',
  'moto_cilindrada',
  'medida_pneu',
  'posicao_pneu',
  'quantidade',
  'marca_preferida',
  'marca_recusada',
  'faixa_preco_max',
]);
export type SessionSlotKey = z.infer<typeof sessionSlotKeySchema>;

export const globalSlotKeySchema = z.enum([
  'nome',
  'bairro',
  'municipio',
  'forma_pagamento',
]);
export type GlobalSlotKey = z.infer<typeof globalSlotKeySchema>;

export const itemSlotKeySchema = z.enum([
  'moto_modelo',
  'moto_ano',
  'moto_cilindrada',
  'medida_pneu',
  'posicao_pneu',
  'quantidade',
  'marca_preferida',
  'marca_recusada',
  'faixa_preco_max',
]);
export type ItemSlotKey = z.infer<typeof itemSlotKeySchema>;

export const paymentMethodSchema = z.enum([
  'pix',
  'dinheiro',
  'cartao_credito',
  'cartao_debito',
  'boleto',
]);

export const tirePositionSchema = z.enum(['dianteiro', 'traseiro', 'ambos']);

export const slotValueSchema = z.object({
  id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  scope: slotScopeSchema,
  item_id: z.string().uuid().nullable(),
  slot_key: sessionSlotKeySchema,
  value_json: z.unknown(),
  source: slotSourceSchema,
  confidence: z.number().min(0).max(1),
  stale: staleFlagSchema.default('fresh'),
  requires_confirmation: z.boolean().default(false),
  evidence_text: z.string().nullable().optional(),
  set_by_message_id: z.string().uuid().nullable().optional(),
  set_by_skill: z.string().nullable().optional(),
  previous_value_json: z.unknown().nullable().optional(),
  set_at: z.string().datetime(),
});
export type SlotValue = z.infer<typeof slotValueSchema>;

export const sessionItemSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid().optional(),
  status: sessionItemStatusSchema,
  is_active: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
});
export type SessionItem = z.infer<typeof sessionItemSchema>;

export const cartLineStateSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid().optional(),
  sku: z.string().optional(),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative().nullable(),
  item_status: z.enum(['proposed', 'confirmed', 'removed']).optional(),
});

export const pendingConfirmationStateSchema = z.object({
  id: z.string().uuid(),
  confirmation_type: z.string(),
  expected_facts: z.record(z.unknown()),
  status: z.string(),
  expires_at: z.string().datetime(),
});

export const orderDraftStateSchema = z.object({
  customer_name: z.string().nullable().default(null),
  delivery_address: z.string().nullable().default(null),
  geo_resolution_id: z.string().uuid().nullable().default(null),
  fulfillment_mode: z.enum(['delivery', 'pickup']).nullable().default(null),
  payment_method: paymentMethodSchema.nullable().default(null),
  draft_status: z.enum(['collecting', 'ready', 'promoted', 'abandoned']).default('collecting'),
  promoted_order_id: z.string().uuid().nullable().default(null),
  promoted_by: z.string().nullable().default(null),
  promoted_at: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type OrderDraftState = z.infer<typeof orderDraftStateSchema>;

export const globalSlotsStateSchema = z.object({
  nome: slotValueSchema.optional(),
  bairro: slotValueSchema.optional(),
  municipio: slotValueSchema.optional(),
  forma_pagamento: slotValueSchema.optional(),
});
export type GlobalSlotsState = z.infer<typeof globalSlotsStateSchema>;

export const itemSlotsStateSchema = z.object({
  moto_modelo: slotValueSchema.optional(),
  moto_ano: slotValueSchema.optional(),
  moto_cilindrada: slotValueSchema.optional(),
  medida_pneu: slotValueSchema.optional(),
  posicao_pneu: slotValueSchema.optional(),
  quantidade: slotValueSchema.optional(),
  marca_preferida: slotValueSchema.optional(),
  marca_recusada: slotValueSchema.optional(),
  faixa_preco_max: slotValueSchema.optional(),
});
export type ItemSlotsState = z.infer<typeof itemSlotsStateSchema>;

export const conversationStateSchema = z.object({
  schema_version: z.literal('atendente_v1.0'),
  environment: z.enum(['prod', 'test']),
  conversation_id: z.string().uuid(),
  contact_id: z.string().uuid().nullable(),
  status: z.enum(['active', 'paused', 'escalated', 'closed']),
  current_skill: z.string().nullable(),
  last_customer_message_id: z.string().uuid().nullable(),
  last_agent_turn_id: z.string().uuid().nullable(),
  last_processed_message_id: z.string().uuid().nullable(),
  version: z.number().int().min(0),
  turn_index: z.number().int().min(0),
  items: z.array(
    sessionItemSchema.extend({
      slots: itemSlotsStateSchema.default({}),
    }),
  ),
  global_slots: globalSlotsStateSchema.default({}),
  cart: z.array(cartLineStateSchema).default([]),
  order_draft: orderDraftStateSchema.nullable().optional(),
  pending_confirmation: pendingConfirmationStateSchema.nullable().default(null),
  last_offer: z
    .object({
      offer_id: z.string().uuid(),
      item_id: z.string().uuid(),
      products: z.array(z.record(z.unknown())),
      expires_at: z.string().datetime(),
      invalidated: z.boolean().default(false),
      invalidation_reason: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  derived_signals: z
    .object({
      missing_for_close: z.array(z.string()).default([]),
      stale_slots: z.array(z.string()).default([]),
      recent_objections: z.array(z.string()).default([]),
      has_pending_human_request: z.boolean().default(false),
      offer_expired: z.boolean().default(false),
    })
    .default({}),
  updated_at: z.string().datetime(),
  created_at: z.string().datetime(),
});
export type ConversationState = z.infer<typeof conversationStateSchema>;

export function isGlobalSlotKey(slotKey: string): slotKey is GlobalSlotKey {
  return globalSlotKeySchema.safeParse(slotKey).success;
}

export function isItemSlotKey(slotKey: string): slotKey is ItemSlotKey {
  return itemSlotKeySchema.safeParse(slotKey).success;
}

export function isCriticalSlot(slotKey: SessionSlotKey): boolean {
  return [
    'moto_modelo',
    'moto_ano',
    'medida_pneu',
    'posicao_pneu',
    'quantidade',
    'bairro',
    'forma_pagamento',
  ].includes(slotKey);
}
