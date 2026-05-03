/**
 * Schemas do Generator Shadow — Sprint 6.
 *
 * O Generator lê contexto + plano + resultados de tools e produz
 * uma resposta candidata auditável. Nunca envia para Chatwoot.
 *
 * Invariantes:
 * - Nunca inventa preço, estoque, frete ou compatibilidade sem tool.
 * - Se faltar dado, usa SAFE_FALLBACK_SAY.
 * - Escreve apenas em agent.turns e agent.session_events (via recordGeneratorResult).
 * - Nunca escreve em raw.*, core.*, analytics.* ou commerce.*.
 */

import { z } from 'zod';
import {
  createItemSchema,
  recordOfferSchema,
  updateSlotSchema,
} from '../../shared/zod/agent-actions.js';

export const generatorPromptVersion = 'generator_v1.0.0';
export const generatorAgentVersion = 'atendente_v1.0.0';

/**
 * Contrato de saída bruta esperado do LLM (antes de passar pelos validators).
 */
export const generatorActionSchema = z.discriminatedUnion('type', [
  updateSlotSchema,
  createItemSchema,
  recordOfferSchema,
]);
export type GeneratorAction = z.infer<typeof generatorActionSchema>;

export const generatorOutputRawSchema = z.object({
  say: z.string().min(1).max(2000),
  actions: z.array(generatorActionSchema).max(10).default([]),
  rationale: z.string().min(1).max(500),
  prompt_version: z.literal(generatorPromptVersion),
});
export type GeneratorOutputRaw = z.infer<typeof generatorOutputRawSchema>;

/**
 * Resultado final do Generator após validação.
 * say_text e actions são nulos quando blocked=true.
 */
export interface GeneratorResult {
  /** Texto candidato (null quando blocked). */
  say_text: string | null;
  /** Actions candidatas (vazio quando blocked). */
  actions: unknown[];
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
