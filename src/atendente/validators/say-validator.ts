import {
  collectDeliveryFees,
  collectToolPrices,
  hasCompatibilityEvidence,
  hasDeliveryEvidence,
  hasStockEvidence,
  type ToolResultForValidation,
} from './tool-results.js';

export type SayValidationResult =
  | { valid: true }
  | { valid: false; reason: string; severity: 'block' | 'warn' };

export interface SayValidationContext {
  recent_tool_results: ToolResultForValidation[];
}

const SAFE_FALLBACK_PHRASE = normalizeText(
  'Desculpe, não consigo confirmar essa informação agora. Um atendente poderá te ajudar em breve.',
);

export function validateSay(say: string, context: SayValidationContext): SayValidationResult {
  const normalizedSay = normalizeText(say);

  if (mixesSafeFallbackWithOtherContent(normalizedSay)) {
    return block('mixed_safe_fallback_with_other_content');
  }

  if (mentionsStockClaim(normalizedSay) && !hasStockEvidence(context.recent_tool_results)) {
    return block('stock_claim_without_verificar_estoque');
  }

  if (mentionsDeliveryClaim(normalizedSay) && !hasDeliveryEvidence(context.recent_tool_results)) {
    return block('delivery_claim_without_calcular_frete');
  }

  if (mentionsCompatibilityClaim(normalizedSay) && !hasCompatibilityEvidence(context.recent_tool_results)) {
    return block('fitment_claim_without_buscar_compatibilidade');
  }

  const mentionedMoney = extractMoneyValues(say);
  if (mentionedMoney.length === 0) return { valid: true };

  const knownPrices = collectToolPrices(context.recent_tool_results);
  const knownFees = collectDeliveryFees(context.recent_tool_results);
  const knownAmounts = new Set([...knownPrices, ...knownFees]);
  if (knownAmounts.size === 0) {
    return block('money_mentioned_without_tool_result');
  }

  for (const amount of mentionedMoney) {
    if (!hasApproxAmount(knownAmounts, amount)) {
      return block(`money_not_supported_by_tool_result:${amount}`);
    }
  }
  return { valid: true };
}

function block(reason: string): SayValidationResult {
  return { valid: false, reason, severity: 'block' };
}

function extractMoneyValues(text: string): number[] {
  const out: number[] = [];
  const moneyPattern = /r\$\s*((?:\d{1,3}(?:\.\d{3})+)|\d+)(?:,(\d{2}))?/gi;
  for (const match of text.matchAll(moneyPattern)) {
    const whole = match[1]?.replace(/\./g, '');
    if (!whole) continue;
    const cents = match[2] ?? '00';
    const amount = Number(`${whole}.${cents}`);
    if (Number.isFinite(amount)) out.push(amount);
  }
  return out;
}

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function mixesSafeFallbackWithOtherContent(text: string): boolean {
  if (!text.includes(SAFE_FALLBACK_PHRASE)) return false;
  return text.replace(SAFE_FALLBACK_PHRASE, '').replace(/[\s.,!?;:()\[\]"'`-]/g, '').length > 0;
}

function mentionsStockClaim(text: string): boolean {
  return [
    /\btem(?:os)?\s+(?:\w+\s+){0,4}(?:em\s+)?estoque\b/,
    /\btem(?:os)?\s+(?:\w+\s+){0,5}disponivel\b/,
    /\b(?:produto|pneu|modelo|medida)\s+(?:esta\s+)?disponivel\b/,
    /\bdisponivel\s+(?:em\s+)?estoque\b/,
    /\bpronta\s+entrega\b/,
    /\b(?:quantidade|unidades?)\s+(?:disponivel|em\s+estoque)\b/,
  ].some((pattern) => pattern.test(text));
}

function mentionsDeliveryClaim(text: string): boolean {
  return [
    /\bfrete\s+(?:fica|sai|custa|e|gratis|disponivel|indisponivel)\b/,
    /\b(?:entrega|delivery)\s+(?:disponivel|indisponivel|gratis|e)\b/,
    /\bentregamos\s+(?:em|no|na|nos|nas|para|pra)\b/,
    /\b(?:entregamos|chega|recebe)\b.{0,40}\b(?:hoje|amanha|em\s+\d+\s+dias?|ate\s+\w+)\b/,
    /\bprazo\b.{0,60}\b(?:hoje|amanha|dia\s+seguinte|em\s+\d+\s+dias?|ate\s+\w+)\b/,
    /\b(?:prazo|previsao)\s+(?:de\s+)?(?:entrega|chegada)\b/,
    /\b\d+\s+dias?\s+(?:uteis\s+)?(?:para\s+)?(?:entrega|chegar|receber)\b/,
  ].some((pattern) => pattern.test(text));
}

function mentionsCompatibilityClaim(text: string): boolean {
  return [
    /\b(?:serve|servem)\s+(?:na|no|para|pra)\b/,
    /\bcompativel\s+(?:com|para|pra)\b/,
    /\b(?:pneu|medida|modelo)\s+(?:certo|correto|ideal)\s+(?:para|pra)\b/,
    /\bencaixa\s+(?:na|no)\b/,
  ].some((pattern) => pattern.test(text));
}

function hasApproxAmount(values: Set<number>, amount: number): boolean {
  for (const value of values) {
    if (Math.abs(value - amount) < 0.01) return true;
  }
  return false;
}
