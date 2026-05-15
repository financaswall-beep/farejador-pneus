/**
 * Schemas do Generator Shadow — Sprint 6 (cru) + Sprint 6.5 (Caminho B).
 *
 * O Generator lê contexto + plano + resultados de tools e produz
 * uma resposta candidata auditável. Nunca envia para Chatwoot.
 *
 * Sprint 6.5 — Caminho B: a LLM devolve actions em formato CRU (sem
 * action_id, turn_index, emitted_at, emitted_by). O código hidrata
 * deterministicamente antes de validar com o schema completo de
 * agentActionSchema. Isso elimina blocks por meta-campos ausentes.
 *
 * Invariantes:
 * - Nunca inventa preço, estoque, frete ou compatibilidade sem tool.
 * - Se faltar dado, usa SAFE_FALLBACK_SAY.
 * - Escreve apenas em agent.turns e agent.session_events (via recordGeneratorResult)
 *   e agora em agent.session_slots / agent.session_items via applyActionAndPersist
 *   (chamado pelo worker após validação).
 * - Nunca escreve em raw.*, core.*, analytics.* ou commerce.*.
 */

import { z } from 'zod';
import {
  agentActionSchema,
  type AgentAction,
  type CreateItemAction,
  type RecordOfferAction,
  type UpdateDraftAction,
  type UpdateSlotAction,
} from '../../shared/zod/agent-actions.js';
import {
  itemSlotKeySchema,
  sessionSlotKeySchema,
  slotScopeSchema,
  slotSourceSchema,
} from '../../shared/zod/agent-state.js';
import { deterministicUuid } from '../../shared/deterministic-id.js';

export const generatorPromptVersion = 'generator_v1.4.0';
export const generatorAgentVersion = 'atendente_v1.0.0';

// ------------------------------------------------------------------
// Schemas CRUS — o que a LLM devolve. Sem campos meta.
// ------------------------------------------------------------------

/**
 * update_slot cru: a LLM só preenche o que ela sabe gerar bem.
 * Campos meta (action_id, turn_index, emitted_at, emitted_by) são
 * preenchidos pelo código no momento da hidratação.
 */
const updateSlotRawSchema = z.object({
  type: z.literal('update_slot'),
  scope: slotScopeSchema,
  item_id: z.string().min(1).nullable(),
  slot_key: sessionSlotKeySchema,
  value: z.unknown(),
  source: slotSourceSchema,
  confidence: z.number().min(0).max(1),
  evidence_text: z.string().nullable().optional(),
  set_by_message_id: z.string().min(1).nullable().optional(),
  set_by_skill: z.string().nullable().optional(),
});

const createItemRawSchema = z.object({
  type: z.literal('create_item'),
  item_id: z.string().min(1),
  make_active: z.boolean().default(true),
});

const recordOfferRawSchema = z.object({
  type: z.literal('record_offer'),
  offer_id: z.string().min(1),
  item_id: z.string().min(1),
  products: z.array(z.record(z.unknown())).min(1).max(10),
  expires_at: z.string().datetime(),
});

const updateDraftRawSchema = z.object({
  type: z.literal('update_draft'),
  customer_name: z.string().min(1).max(120).nullable().optional(),
  delivery_address: z.string().min(1).max(500).nullable().optional(),
  fulfillment_mode: z.enum(['delivery', 'pickup']).nullable().optional(),
  payment_method: z.enum(['pix', 'cartao_credito', 'cartao_debito', 'dinheiro', 'boleto']).nullable().optional(),
});

export const generatorRawActionSchema = z.discriminatedUnion('type', [
  updateSlotRawSchema,
  createItemRawSchema,
  recordOfferRawSchema,
  updateDraftRawSchema,
]);
export type GeneratorRawAction = z.infer<typeof generatorRawActionSchema>;

// ------------------------------------------------------------------
// Structured commercial claims (Etapa 2 — 2026-05-15)
//
// Quando o Generator afirma algo comercial na resposta (preco, estoque,
// compatibilidade, frete), tambem emite um claim estruturado apontando
// a tool que confirma. O ClaimValidator checa cada claim contra os
// tool_results do turn — sem regex sobre a fala humana do bot.
//
// Migracao gradual: claims default=[]. LLM pode nao emitir nada (legado).
// Quando emite, validator bloqueia se claim nao tem evidencia.
// ------------------------------------------------------------------

const priceClaimSchema = z.object({
  type: z.literal('price'),
  /** Valor afirmado (R$). Validator compara com price_amount do buscarProduto (±R$0,01). */
  amount: z.number().positive(),
  /** Optional — quando informado, refina a checagem para esse produto especifico. */
  product_id: z.string().min(1).nullable().optional(),
});

const stockClaimSchema = z.object({
  type: z.literal('stock_availability'),
  /** Optional — quando informado, validator exige verificarEstoque deste product_id. */
  product_id: z.string().min(1).nullable().optional(),
});

const fitmentClaimSchema = z.object({
  type: z.literal('fitment'),
  /** Optional — produto sendo afirmado como compativel. */
  product_id: z.string().min(1).nullable().optional(),
  /** Optional — texto descritivo da moto/veiculo (apenas hint, nao usado em validacao estrita). */
  vehicle_hint: z.string().max(120).nullable().optional(),
});

const deliveryFeeClaimSchema = z.object({
  type: z.literal('delivery_fee'),
  /** Optional — valor de frete afirmado. Validator compara com valor de calcularFrete (±R$0,01). */
  amount: z.number().nonnegative().nullable().optional(),
});

export const generatorClaimSchema = z.discriminatedUnion('type', [
  priceClaimSchema,
  stockClaimSchema,
  fitmentClaimSchema,
  deliveryFeeClaimSchema,
]);
export type GeneratorClaim = z.infer<typeof generatorClaimSchema>;

/**
 * Schema da resposta crua da LLM Generator (sem meta nas actions).
 */
export const generatorOutputRawSchema = z.object({
  say: z.string().min(1).max(2000),
  actions: z.array(generatorRawActionSchema).max(10).default([]),
  /**
   * Etapa 2: claims estruturados sobre afirmacoes comerciais em `say`.
   * Default `[]` — turns que nao afirmam nada comercial.
   */
  claims: z.array(generatorClaimSchema).max(20).default([]),
  rationale: z.string().min(1).max(500),
  prompt_version: z.literal(generatorPromptVersion),
});
export type GeneratorOutputRaw = z.infer<typeof generatorOutputRawSchema>;

export const generatorOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['say', 'actions', 'claims', 'rationale', 'prompt_version'],
  properties: {
    say: { type: 'string', minLength: 1, maxLength: 2000 },
    actions: {
      type: 'array',
      maxItems: 10,
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'scope', 'item_id', 'slot_key', 'value', 'source', 'confidence', 'evidence_text', 'set_by_message_id'],
            properties: {
              type: { type: 'string', enum: ['update_slot'] },
              scope: { type: 'string', enum: ['global', 'item'] },
              item_id: { type: ['string', 'null'] },
              slot_key: { type: 'string' },
              value: {
                anyOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' },
                  { type: 'null' },
                  {
                    type: 'array',
                    items: {
                      anyOf: [
                        { type: 'string' },
                        { type: 'number' },
                        { type: 'boolean' },
                        { type: 'null' },
                      ],
                    },
                  },
                ],
              },
              source: {
                type: 'string',
                enum: [
                  'observed',
                  'inferred',
                  'confirmed',
                  'offered_to_client',
                  'inferred_from_history',
                  'inferred_from_organizadora',
                ],
              },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              evidence_text: { type: ['string', 'null'] },
              set_by_message_id: { type: ['string', 'null'] },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'item_id', 'make_active'],
            properties: {
              type: { type: 'string', enum: ['create_item'] },
              item_id: { type: 'string' },
              make_active: { type: 'boolean' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'offer_id', 'item_id', 'products', 'expires_at'],
            properties: {
              type: { type: 'string', enum: ['record_offer'] },
              offer_id: { type: 'string' },
              item_id: { type: 'string' },
              products: {
                type: 'array',
                minItems: 1,
                maxItems: 10,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'product_id',
                    'product_code',
                    'tire_size',
                    'tire_position',
                    'price_amount',
                    'total_stock_available',
                  ],
                  properties: {
                    product_id: { type: ['string', 'null'] },
                    product_code: { type: ['string', 'null'] },
                    tire_size: { type: ['string', 'null'] },
                    tire_position: { type: ['string', 'null'] },
                    price_amount: { type: ['string', 'number', 'null'] },
                    total_stock_available: { type: ['number', 'null'] },
                  },
                },
              },
              expires_at: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'customer_name', 'delivery_address', 'fulfillment_mode', 'payment_method'],
            properties: {
              type: { type: 'string', enum: ['update_draft'] },
              customer_name: { type: ['string', 'null'] },
              delivery_address: { type: ['string', 'null'] },
              fulfillment_mode: { type: ['string', 'null'], enum: ['delivery', 'pickup', null] },
              payment_method: {
                type: ['string', 'null'],
                enum: ['pix', 'cartao_credito', 'cartao_debito', 'dinheiro', 'boleto', null],
              },
            },
          },
        ],
      },
    },
    claims: {
      type: 'array',
      maxItems: 20,
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'amount', 'product_id'],
            properties: {
              type: { type: 'string', enum: ['price'] },
              amount: { type: 'number' },
              product_id: { type: ['string', 'null'] },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'product_id'],
            properties: {
              type: { type: 'string', enum: ['stock_availability'] },
              product_id: { type: ['string', 'null'] },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'product_id', 'vehicle_hint'],
            properties: {
              type: { type: 'string', enum: ['fitment'] },
              product_id: { type: ['string', 'null'] },
              vehicle_hint: { type: ['string', 'null'] },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'amount'],
            properties: {
              type: { type: 'string', enum: ['delivery_fee'] },
              amount: { type: ['number', 'null'] },
            },
          },
        ],
      },
    },
    rationale: { type: 'string', minLength: 1, maxLength: 500 },
    prompt_version: { type: 'string', enum: [generatorPromptVersion] },
  },
} as const;

// ------------------------------------------------------------------
// Hidratação: cru → AgentAction validado.
// ------------------------------------------------------------------

export interface HydrationContext {
  conversation_id: string;
  turn_index: number;
  emitted_at: string;
  selected_skill?: string | null;
  latest_customer_message_id?: string | null;
}

const uuidLikeRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeGeneratedId(namespace: string, ctx: HydrationContext, rawId: string): string {
  return uuidLikeRegex.test(rawId)
    ? rawId
    : deterministicUuid([namespace, ctx.conversation_id, ctx.turn_index, rawId]);
}

function normalizeOptionalMessageId(rawId: string | null | undefined, ctx: HydrationContext): string | null {
  if (rawId && uuidLikeRegex.test(rawId)) return rawId;
  if (ctx.latest_customer_message_id && uuidLikeRegex.test(ctx.latest_customer_message_id)) {
    return ctx.latest_customer_message_id;
  }
  return null;
}

/**
 * Hidrata uma raw action adicionando os meta-campos de forma determinística.
 * O action_id é determinístico (sha256 do payload + conversa + turn) — assim
 * retry da mesma decisão cai em ON CONFLICT (action_id) DO NOTHING e não duplica.
 *
 * Se o resultado falha no schema completo de agentActionSchema, retorna null.
 * Isso só deveria acontecer se a LLM devolver valor com tipo errado dentro do raw,
 * caso em que o erro vira block_reason no caller.
 */
export function hydrateGeneratorAction(
  raw: GeneratorRawAction,
  ctx: HydrationContext,
  itemIdMap: Map<string, string> = new Map(),
): AgentAction | null {
  const actionId = deterministicUuid([
    'generator_action',
    ctx.conversation_id,
    ctx.turn_index,
    raw,
  ]);

  const base = {
    action_id: actionId,
    turn_index: ctx.turn_index,
    emitted_at: ctx.emitted_at,
    emitted_by: 'generator' as const,
  };

  let candidate: UpdateSlotAction | CreateItemAction | RecordOfferAction | UpdateDraftAction;

  switch (raw.type) {
    case 'update_slot':
      candidate = {
        ...base,
        type: 'update_slot',
        scope: raw.scope,
        item_id: raw.item_id ? itemIdMap.get(raw.item_id) ?? normalizeGeneratedId('generator_item', ctx, raw.item_id) : null,
        slot_key: raw.slot_key,
        value: raw.value,
        source: raw.source,
        confidence: raw.confidence,
        evidence_text: raw.evidence_text ?? null,
        set_by_message_id: normalizeOptionalMessageId(raw.set_by_message_id, ctx),
        set_by_skill: raw.set_by_skill ?? ctx.selected_skill ?? null,
      };
      break;
    case 'create_item':
      candidate = {
        ...base,
        type: 'create_item',
        item_id: itemIdMap.get(raw.item_id) ?? normalizeGeneratedId('generator_item', ctx, raw.item_id),
        make_active: raw.make_active,
      };
      break;
    case 'record_offer':
      candidate = {
        ...base,
        type: 'record_offer',
        offer_id: normalizeGeneratedId('generator_offer', ctx, raw.offer_id),
        item_id: itemIdMap.get(raw.item_id) ?? normalizeGeneratedId('generator_item', ctx, raw.item_id),
        products: raw.products,
        expires_at: raw.expires_at,
      };
      break;
    case 'update_draft':
      candidate = {
        ...base,
        type: 'update_draft',
        ...(raw.customer_name ? { customer_name: raw.customer_name } : {}),
        ...(raw.delivery_address ? { delivery_address: raw.delivery_address } : {}),
        ...(raw.fulfillment_mode ? { fulfillment_mode: raw.fulfillment_mode } : {}),
        ...(raw.payment_method ? { payment_method: raw.payment_method } : {}),
      };
      break;
  }

  const parsed = agentActionSchema.safeParse(candidate);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

/**
 * Hidrata todas as actions cruas. Retorna { actions, invalid_indexes }.
 * Caller decide bloquear ou prosseguir parcialmente.
 */
export function hydrateGeneratorActions(
  raws: GeneratorRawAction[],
  ctx: HydrationContext,
): { actions: AgentAction[]; invalid_indexes: number[] } {
  const actions: AgentAction[] = [];
  const invalid_indexes: number[] = [];
  const itemIdMap = new Map<string, string>();

  for (const raw of raws) {
    if (raw.type === 'create_item') {
      itemIdMap.set(raw.item_id, normalizeGeneratedId('generator_item', ctx, raw.item_id));
    }
  }

  for (let index = 0; index < raws.length; index += 1) {
    const raw = raws[index]!;
    const hydrated = hydrateGeneratorAction(raw, ctx, itemIdMap);
    if (hydrated) {
      actions.push(hydrated);
    } else {
      invalid_indexes.push(index);
    }
  }

  return { actions, invalid_indexes };
}

// ------------------------------------------------------------------
// Helpers de validação extra (whitelist de slot_key por scope).
// ActionValidator já cobre, mas alguns testes esperam a checagem aqui.
// ------------------------------------------------------------------

export function isItemScopeSlotKey(slotKey: string): boolean {
  return itemSlotKeySchema.safeParse(slotKey).success;
}

// ------------------------------------------------------------------
// Resultado final do Generator após validação.
// ------------------------------------------------------------------

/**
 * say_text e actions são nulos/vazios quando blocked=true.
 * actions já vêm hidratadas (AgentAction[]).
 */
export interface GeneratorResult {
  /** Texto candidato (null quando blocked). */
  say_text: string | null;
  /** Actions hidratadas e validadas (vazio quando blocked). */
  actions: AgentAction[];
  /** true = resposta bloqueada pelos validators ou falta de lastro. */
  blocked: boolean;
  /** Motivo do bloqueio, preenchido quando blocked=true. */
  block_reason: string | null;
  /** Texto candidato bloqueado. Preenchido apenas quando havia candidato auditavel. */
  candidate_say_text: string | null;
  /** Actions candidatas hidratadas antes do bloqueio. */
  candidate_actions: AgentAction[];
  /** Actions cruas recebidas da LLM, quando disponiveis para auditoria. */
  candidate_raw_actions?: unknown[];
  used_llm: boolean;
  fallback_used: boolean;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

/**
 * Texto seguro de fallback — usado sempre que falta dado ou resposta é bloqueada.
 * NÃO contém nenhum valor factual inventado.
 */
export const SAFE_FALLBACK_SAY =
  'Desculpe, não consigo confirmar essa informação agora. Um atendente poderá te ajudar em breve.';
