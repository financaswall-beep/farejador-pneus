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
  type UpdateSlotAction,
} from '../../shared/zod/agent-actions.js';
import {
  itemSlotKeySchema,
  sessionSlotKeySchema,
  slotScopeSchema,
  slotSourceSchema,
} from '../../shared/zod/agent-state.js';
import { deterministicUuid } from '../../shared/deterministic-id.js';

export const generatorPromptVersion = 'generator_v1.1.0';
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
  item_id: z.string().uuid().nullable(),
  slot_key: sessionSlotKeySchema,
  value: z.unknown(),
  source: slotSourceSchema,
  confidence: z.number().min(0).max(1),
  evidence_text: z.string().nullable().optional(),
  set_by_message_id: z.string().uuid().nullable().optional(),
  set_by_skill: z.string().nullable().optional(),
});

const createItemRawSchema = z.object({
  type: z.literal('create_item'),
  item_id: z.string().uuid(),
  make_active: z.boolean().default(true),
});

const recordOfferRawSchema = z.object({
  type: z.literal('record_offer'),
  offer_id: z.string().uuid(),
  item_id: z.string().uuid(),
  products: z.array(z.record(z.unknown())).min(1).max(10),
  expires_at: z.string().datetime(),
});

export const generatorRawActionSchema = z.discriminatedUnion('type', [
  updateSlotRawSchema,
  createItemRawSchema,
  recordOfferRawSchema,
]);
export type GeneratorRawAction = z.infer<typeof generatorRawActionSchema>;

/**
 * Schema da resposta crua da LLM Generator (sem meta nas actions).
 */
export const generatorOutputRawSchema = z.object({
  say: z.string().min(1).max(2000),
  actions: z.array(generatorRawActionSchema).max(10).default([]),
  rationale: z.string().min(1).max(500),
  prompt_version: z.literal(generatorPromptVersion),
});
export type GeneratorOutputRaw = z.infer<typeof generatorOutputRawSchema>;

// ------------------------------------------------------------------
// Hidratação: cru → AgentAction validado.
// ------------------------------------------------------------------

export interface HydrationContext {
  conversation_id: string;
  turn_index: number;
  emitted_at: string;
  selected_skill?: string | null;
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

  let candidate: UpdateSlotAction | CreateItemAction | RecordOfferAction;

  switch (raw.type) {
    case 'update_slot':
      candidate = {
        ...base,
        type: 'update_slot',
        scope: raw.scope,
        item_id: raw.item_id,
        slot_key: raw.slot_key,
        value: raw.value,
        source: raw.source,
        confidence: raw.confidence,
        evidence_text: raw.evidence_text ?? null,
        set_by_message_id: raw.set_by_message_id ?? null,
        set_by_skill: raw.set_by_skill ?? ctx.selected_skill ?? null,
      };
      break;
    case 'create_item':
      candidate = {
        ...base,
        type: 'create_item',
        item_id: raw.item_id,
        make_active: raw.make_active,
      };
      break;
    case 'record_offer':
      candidate = {
        ...base,
        type: 'record_offer',
        offer_id: raw.offer_id,
        item_id: raw.item_id,
        products: raw.products,
        expires_at: raw.expires_at,
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

  for (let index = 0; index < raws.length; index += 1) {
    const raw = raws[index]!;
    const hydrated = hydrateGeneratorAction(raw, ctx);
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
