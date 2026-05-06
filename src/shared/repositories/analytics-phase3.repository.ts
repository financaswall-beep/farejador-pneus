/**
 * Repository para analytics.* - Fase 3.
 * Cobre: conversation_facts (insert + supersede) e fact_evidence (insert).
 *
 * Invariante sagrada: NUNCA UPDATE de valor. Mudanca = nova linha + superseded_by.
 */

import type { PoolClient } from 'pg';
import type { Environment } from '../types/chatwoot.js';
import type { EvidenceType, TruthType } from '../types/analytics-phase3.js';

export interface FactInsert {
  environment: Environment;
  conversation_id: string;
  fact_key: string;
  /** Valor primitivo ou objeto. Vai para JSONB. */
  fact_value: unknown;
  observed_at: Date | null;
  /** Logical FK -> core.messages(id). Partitioned. */
  message_id: string | null;
  truth_type: TruthType;
  source: string;
  confidence_level: number;
  extractor_version: string;
}

export interface EvidenceInsert {
  environment: Environment;
  fact_id: string;
  /** Logical FK -> core.messages(id). Partitioned. */
  from_message_id: string;
  evidence_text: string;
  evidence_type: EvidenceType;
  extractor_version: string;
}

interface ActiveFactRow {
  id: string;
  truth_type: TruthType;
  confidence_level: string | null;
  fact_value: unknown;
}

/**
 * Insere um novo fact e liga sua evidence.
 *
 * Se ja existe fact ativo para a mesma conversa+chave:
 * - novo fato mais forte/igual supersede o anterior;
 * - novo fato mais fraco ja nasce superseded pelo fato ativo.
 *
 * Deve ser chamado dentro de uma transacao aberta pelo caller.
 */
export async function writeFactWithEvidence(
  client: PoolClient,
  fact: FactInsert,
  evidence: Omit<EvidenceInsert, 'fact_id' | 'environment'>,
): Promise<string> {
  const activeFact = await findActiveFact(client, fact);

  // Dedup: se o fact ativo ja tem o mesmo valor (deep equal), mesma truth_type e confidence >= novo,
  // nao insere linha nova; apenas anexa evidence ao fact existente. Mantem ledger limpo.
  if (
    activeFact &&
    activeFact.truth_type === fact.truth_type &&
    Number(activeFact.confidence_level ?? 0) >= fact.confidence_level &&
    deepEqualJsonValue(activeFact.fact_value, fact.fact_value)
  ) {
    await client.query(
      `INSERT INTO analytics.fact_evidence
         (environment, fact_id, from_message_id, evidence_text, evidence_type, extractor_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (fact_id, from_message_id, evidence_type) DO NOTHING`,
      [
        fact.environment,
        activeFact.id,
        evidence.from_message_id,
        evidence.evidence_text,
        evidence.evidence_type,
        evidence.extractor_version,
      ],
    );
    return activeFact.id;
  }

  const supersedesActive = activeFact ? shouldSupersedeFact(fact, activeFact) : false;
  const supersededBy = activeFact && !supersedesActive ? activeFact.id : null;

  const factResult = await client.query<{ id: string }>(
    `INSERT INTO analytics.conversation_facts
       (environment, conversation_id, fact_key, fact_value,
        observed_at, message_id, truth_type, source,
        confidence_level, extractor_version, superseded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      fact.environment,
      fact.conversation_id,
      fact.fact_key,
      JSON.stringify(fact.fact_value),
      fact.observed_at,
      fact.message_id,
      fact.truth_type,
      fact.source,
      fact.confidence_level,
      fact.extractor_version,
      supersededBy,
    ],
  );

  const newFactId = factResult.rows[0]!.id;

  if (activeFact && supersedesActive) {
    await client.query(
      `UPDATE analytics.conversation_facts
       SET superseded_by = $1
       WHERE id = $2
         AND environment = $3
         AND superseded_by IS NULL`,
      [newFactId, activeFact.id, fact.environment],
    );
  }

  await client.query(
    `INSERT INTO analytics.fact_evidence
       (environment, fact_id, from_message_id, evidence_text, evidence_type, extractor_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (fact_id, from_message_id, evidence_type) DO NOTHING`,
    [
      fact.environment,
      newFactId,
      evidence.from_message_id,
      evidence.evidence_text,
      evidence.evidence_type,
      evidence.extractor_version,
    ],
  );

  return newFactId;
}

async function findActiveFact(
  client: PoolClient,
  fact: Pick<FactInsert, 'environment' | 'conversation_id' | 'fact_key'>,
): Promise<ActiveFactRow | null> {
  const result = await client.query<ActiveFactRow>(
    `SELECT id, truth_type, confidence_level::text AS confidence_level, fact_value
     FROM analytics.conversation_facts
     WHERE environment = $1
       AND conversation_id = $2
       AND fact_key = $3
       AND superseded_by IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [fact.environment, fact.conversation_id, fact.fact_key],
  );
  return result.rows[0] ?? null;
}

function deepEqualJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  // Comparacao via JSON.stringify com chaves ordenadas — suficiente para JSONB simples.
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function truthRank(truthType: TruthType): number {
  switch (truthType) {
    case 'corrected':
      return 4;
    case 'observed':
      return 3;
    case 'inferred':
      return 2;
    case 'predicted':
      return 1;
    default:
      return 0;
  }
}

export function shouldSupersedeFact(
  incoming: Pick<FactInsert, 'truth_type' | 'confidence_level'>,
  current: Pick<ActiveFactRow, 'truth_type' | 'confidence_level'>,
): boolean {
  const incomingRank = truthRank(incoming.truth_type);
  const currentRank = truthRank(current.truth_type);
  const currentConfidence = Number(current.confidence_level ?? 0);

  return incomingRank > currentRank || incoming.confidence_level >= currentConfidence;
}

export interface CurrentFactRow {
  id: string;
  fact_key: string;
  fact_value: unknown;
  truth_type: string;
  confidence_level: string;
  source: string;
  latest_evidence_text: string | null;
}

export async function listCurrentFacts(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
): Promise<CurrentFactRow[]> {
  const result = await client.query<CurrentFactRow>(
    `SELECT id, fact_key, fact_value, truth_type, confidence_level, source, latest_evidence_text
     FROM analytics.current_facts
     WHERE environment = $1
       AND conversation_id = $2
     ORDER BY fact_key`,
    [environment, conversationId],
  );
  return result.rows;
}
