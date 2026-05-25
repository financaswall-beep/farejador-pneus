/**
 * Zod schemas for the Organizadora LLM response envelope (Fase 3).
 *
 * The Organizadora worker sends a conversation transcript to the LLM and
 * expects back a JSON object containing extracted facts. Each fact:
 * - Has a `fact_key` that must be in the FACT_KEY_SCHEMAS whitelist.
 * - Has a `fact_value` that passes the matching schema in FACT_KEY_SCHEMAS.
 * - Has mandatory `evidence_text` + `from_message_id` (evidence_required=true for all keys).
 * - Has `truth_type`, `confidence_level`, `extractor_version`.
 *
 * Worker validation pipeline:
 * 1. Parse the raw LLM string with JSON.parse() — malformed JSON → llm_api_error incident.
 * 2. Validate envelope with llmOrganizadoraResponseSchema.safeParse() — schema mismatch → llm_api_error.
 * 3. For each fact, call validateFactValue(fact_key, fact_value) from fact-keys.ts:
 *    - Null return (unknown key) → schema_violation incident, fact rejected.
 *    - Failed parse → schema_violation incident, fact rejected.
 * 4. Surviving facts are written to analytics.conversation_facts + analytics.fact_evidence.
 *
 * Source of truth: docs/phase3-agent-architecture/05-fact-ledger-organizadora.md
 */

import { z } from 'zod';

// ------------------------------------------------------------------
// A single extracted fact as returned by the LLM Organizadora
// ------------------------------------------------------------------

export const extractedFactSchema = z.object({
  /**
   * Aceita string livre. A validacao contra VALID_FACT_KEYS acontece DEPOIS
   * do parse, em organizadora/worker.ts via validateFactValue() — fact-a-fact.
   *
   * Antes esse campo tinha refine() rejeitando keys fora da whitelist no parse,
   * mas isso descartava o batch INTEIRO quando 1 fact_key era invalido. Agora
   * o parse aceita qualquer string; a chave invalida vira incidente individual
   * (schema_violation com fact_key especifico) e os outros facts validos sao
   * salvos normalmente.
   */
  fact_key: z.string().min(1),

  /**
   * The extracted value. Type depends on the fact_key — validated in step 3.
   * Stored as JSONB in analytics.conversation_facts.fact_value.
   */
  fact_value: z.unknown(),

  /**
   * The message that the fact was extracted from.
   * Must be a real message_id from the conversation transcript passed to the LLM.
   */
  from_message_id: z.string().uuid({ message: 'from_message_id must be a valid UUID' }),

  /**
   * The literal text from the message that supports this fact.
   * For truth_type=observed this must be a verbatim excerpt.
   * For truth_type=inferred it may be interpretive but must still reference the message.
   */
  evidence_text: z.string().min(1).max(1000),

  /**
   * How the fact was derived.
   * observed: directly stated by the customer.
   * inferred: not explicit but clearly implied.
   * corrected: customer explicitly corrected a previous statement.
   * predicted: not used by Organizadora (reserved for analytics models).
   */
  truth_type: z.enum(['observed', 'inferred', 'corrected']),

  /**
   * Confidence 0.0–1.0. Minimum 0.55 per extraction-schema.json promotion_rules.
   * Facts below minimum are logged as a warning but not rejected outright —
   * the worker may apply a threshold before writing.
   */
  confidence_level: z
    .number()
    .min(0)
    .max(1),

  evidence_type: z.enum(['literal', 'inferred', 'confirmed_by_question']).default('literal'),
});

export type ExtractedFact = z.infer<typeof extractedFactSchema>;

// ------------------------------------------------------------------
// Full Organizadora LLM response
// ------------------------------------------------------------------

export const llmOrganizadoraResponseSchema = z.object({
  /**
   * Version tag of the extraction schema the LLM was prompted with.
   * Must match the schema_version in segments/moto-pneus/extraction-schema.json.
   * Mismatch → incident logged (schema_violation), all facts rejected.
   */
  schema_version: z.string().min(1),

  /**
   * Extracted facts. May be empty array if no structured facts were found.
   * Max 30 (one per fact_key in whitelist) — prevents hallucinated flooding.
   */
  facts: z.array(extractedFactSchema).max(30),

  /**
   * Optional: free-text reasoning the LLM used. Not stored in DB.
   * Useful for debugging schema_violations in ops.agent_incidents.details.
   */
  reasoning: z.string().max(2000).optional(),
});

export type LLMOrganizadoraResponse = z.infer<typeof llmOrganizadoraResponseSchema>;

// ------------------------------------------------------------------
// Parse helper used by the Organizadora worker
// ------------------------------------------------------------------

/**
 * Parse and validate the raw string returned by the LLM Organizadora.
 * Returns a discriminated result so the worker can log structured incidents.
 *
 * @example
 * const result = parseOrganizadoraResponse(rawLLMString, 'moto-pneus-v1');
 * if (result.ok) {
 *   for (const fact of result.data.facts) { ... }
 * } else {
 *   // log ops.agent_incidents with result.error
 * }
 */
export function parseOrganizadoraResponse(
  raw: string,
  expectedSchemaVersion: string,
):
  | { ok: true; data: LLMOrganizadoraResponse }
  | { ok: false; error: string; details: unknown } {
  // 1. JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: 'llm_response_not_json',
      details: { raw: raw.slice(0, 500), parseError: String(err) },
    };
  }

  // 2. Schema validation
  const result = llmOrganizadoraResponseSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: 'llm_response_schema_mismatch',
      details: { issues: result.error.issues },
    };
  }

  // 3. schema_version guard
  if (result.data.schema_version !== expectedSchemaVersion) {
    return {
      ok: false,
      error: 'schema_version_mismatch',
      details: {
        expected: expectedSchemaVersion,
        received: result.data.schema_version,
      },
    };
  }

  return { ok: true, data: result.data };
}
