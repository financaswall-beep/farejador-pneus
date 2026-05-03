import type { ExtractedFact } from '../shared/zod/llm-organizadora.js';
import type { MessageForPrompt } from '../shared/repositories/core-reader.repository.js';
import { validateFactValue } from '../shared/zod/fact-keys.js';

export const DETERMINISTIC_FACT_SOURCE = 'deterministic_literal_organizadora_v1';

export type DeterministicFact = ExtractedFact & {
  source: typeof DETERMINISTIC_FACT_SOURCE;
};

type FactKey = ExtractedFact['fact_key'];

interface LiteralMatch {
  value: string;
  evidence: string;
  messageId: string;
  messageContent: string;
}

const PAYMENT_PATTERNS = [
  { value: 'pix', regex: /\bpix\b/i },
  { value: 'dinheiro', regex: /\bdinheiro\b/i },
  { value: 'boleto', regex: /\bboleto\b/i },
  { value: 'cartao_credito', regex: /\bcr[e\u00e9]dito\b/i },
  { value: 'cartao_debito', regex: /\bd[e\u00e9]bito\b/i },
  { value: 'indefinido', regex: /\bcart[a\u00e3]o\b/i },
] as const;

const DELIVERY_PATTERNS = [
  { value: 'entrega', regex: /\bentrega\b/i },
  { value: 'entrega', regex: /\bentregar\b/i },
  { value: 'entrega', regex: /\bfrete\b/i },
  { value: 'retirada', regex: /\bretirar\b/i },
  { value: 'retirada', regex: /\bretirada\b/i },
  { value: 'retirada', regex: /\bbuscar na loja\b/i },
  { value: 'retirada', regex: /\bpegar na loja\b/i },
] as const;

export function inferDeterministicFacts(
  messages: MessageForPrompt[],
  existingFacts: Array<Pick<ExtractedFact, 'fact_key' | 'fact_value'>>,
): DeterministicFact[] {
  const existingKeys = new Set(
    existingFacts
      .filter((fact) => validateFactValue(fact.fact_key, fact.fact_value)?.success === true)
      .map((fact) => fact.fact_key),
  );
  const facts: DeterministicFact[] = [];

  if (!existingKeys.has('forma_pagamento')) {
    const payment = inferSingleLiteral(messages, PAYMENT_PATTERNS);
    if (payment) facts.push(toFact('forma_pagamento', payment));
  }

  if (!existingKeys.has('modalidade_entrega')) {
    const delivery = inferSingleLiteral(messages, DELIVERY_PATTERNS);
    if (delivery) facts.push(toFact('modalidade_entrega', delivery));
  }

  return facts;
}

function inferSingleLiteral(
  messages: MessageForPrompt[],
  patterns: ReadonlyArray<{ value: string; regex: RegExp }>,
): LiteralMatch | null {
  const matches: LiteralMatch[] = [];

  for (const message of messages) {
    if (message.sender_type !== 'contact') continue;
    const content = message.content ?? '';
    for (const pattern of patterns) {
      const match = content.match(pattern.regex);
      if (match?.[0]) {
        matches.push({
          value: pattern.value,
          evidence: match[0],
          messageId: message.id,
          messageContent: content,
        });
      }
    }
  }

  if (matches.length === 0) return null;

  const distinctValues = [...new Set(matches.map((match) => match.value))];
  if (distinctValues.length === 1) {
    return matches[0]!;
  }

  return {
    value: 'indefinido',
    evidence: matches[0]!.messageContent,
    messageId: matches[0]!.messageId,
    messageContent: matches[0]!.messageContent,
  };
}

function toFact(factKey: FactKey, match: LiteralMatch): DeterministicFact {
  return {
    fact_key: factKey,
    fact_value: match.value,
    from_message_id: match.messageId,
    evidence_text: match.evidence,
    truth_type: 'observed',
    confidence_level: 1,
    evidence_type: 'literal',
    source: DETERMINISTIC_FACT_SOURCE,
  };
}
