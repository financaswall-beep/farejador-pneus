import {
  collectDeliveryFees,
  collectPolicyMoney,
  collectPolicyResults,
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
  /** Skill selecionada pelo Planner; quando 'pedir_dados_faltantes' o fallback seguro fica proibido. */
  selected_skill?: string;
}

const SAFE_FALLBACK_PHRASE = normalizeText(
  'Desculpe, não consigo confirmar essa informação agora. Um atendente poderá te ajudar em breve.',
);

export function validateSay(say: string, context: SayValidationContext): SayValidationResult {
  const normalizedSay = normalizeText(say);

  if (mixesSafeFallbackWithOtherContent(normalizedSay)) {
    return block('mixed_safe_fallback_with_other_content');
  }

  // Sprint v1.3.1: skill 'pedir_dados_faltantes' nao pode terminar em fallback seco.
  // Em vez disso, o Generator deve pedir o slot ausente.
  if (context.selected_skill === 'pedir_dados_faltantes' && isExactSafeFallback(normalizedSay)) {
    return block('safe_fallback_not_allowed_for_pedir_dados_faltantes');
  }

  if (mentionsStockClaim(normalizedSay) && !hasStockEvidence(context.recent_tool_results)) {
    return block('stock_claim_without_verificar_estoque');
  }

  const brandClaim = detectBrandAvailabilityClaim(normalizedSay);
  if (brandClaim && !hasBrandEvidence(context.recent_tool_results, brandClaim)) {
    return block('brand_claim_without_buscar_produto');
  }

  if (mentionsDeliveryClaim(normalizedSay) && !hasDeliveryEvidence(context.recent_tool_results)) {
    return block('delivery_claim_without_calcular_frete');
  }

  if (mentionsCompatibilityClaim(normalizedSay) && !hasCompatibilityEvidence(context.recent_tool_results)) {
    return block('fitment_claim_without_buscar_compatibilidade');
  }

  const policyClaim = detectPolicyClaim(say);
  if (policyClaim) {
    const policyResults = collectPolicyResults(context.recent_tool_results);
    if (!hasRelevantPolicyEvidence(policyClaim, policyResults)) {
      return block('policy_claim_without_tool_result');
    }
    if (policyClaimMismatchesToolResult(policyClaim, policyResults)) {
      return block('policy_claim_mismatches_tool_result');
    }
  }

  const mentionedMoney = extractMoneyValues(say);
  if (mentionedMoney.length === 0) return { valid: true };

  const knownPrices = collectToolPrices(context.recent_tool_results);
  const knownFees = collectDeliveryFees(context.recent_tool_results);
  const knownPolicyMoney = collectPolicyMoney(context.recent_tool_results);
  const knownAmounts = new Set([...knownPrices, ...knownFees, ...knownPolicyMoney]);
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

function isExactSafeFallback(text: string): boolean {
  if (!text.includes(SAFE_FALLBACK_PHRASE)) return false;
  // Mesma logica do mixed-check, mas invertida: sobra apenas pontuacao/whitespace.
  return text.replace(SAFE_FALLBACK_PHRASE, '').replace(/[\s.,!?;:()\[\]"'`-]/g, '').length === 0;
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

const KNOWN_TIRE_BRANDS = [
  'pirelli',
  'michelin',
  'metzeler',
  'levorin',
  'technics',
  'technic',
  'maggion',
  'rinaldi',
  'vipal',
  'magnum',
  'ira',
  'durable',
  'dunlop',
  'city',
];

function detectBrandAvailabilityClaim(text: string): string | null {
  for (const brand of KNOWN_TIRE_BRANDS) {
    const escapedBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`\\btem(?:os)?\\s+(?:pneu\\s+)?(?:da\\s+marca\\s+)?${escapedBrand}\\b`),
      new RegExp(`\\b${escapedBrand}\\s+sim\\b`),
      new RegExp(`\\btrabalhamos\\s+com\\s+${escapedBrand}\\b`),
      new RegExp(`\\b(?:marca|pneu)\\s+${escapedBrand}\\s+(?:tem|temos|disponivel|ok)\\b`),
    ];
    if (patterns.some((pattern) => pattern.test(text))) return brand;
  }
  return null;
}

function hasBrandEvidence(results: ToolResultForValidation[], brand: string): boolean {
  return results.some(
    (result) =>
      result.ok &&
      (result.tool === 'buscarProduto' || result.tool === 'buscarCompatibilidade') &&
      valueContainsBrand(result.output, brand, 0),
  );
}

function valueContainsBrand(value: unknown, brand: string, depth: number): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') return normalizeText(value).includes(brand);
  if (Array.isArray(value)) return value.some((item) => valueContainsBrand(item, brand, depth + 1));
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  for (const key of ['brand', 'product_name', 'short_description', 'marca', 'name']) {
    if (valueContainsBrand(record[key], brand, depth + 1)) return true;
  }
  return Object.values(record).some((nested) => valueContainsBrand(nested, brand, depth + 1));
}

function mentionsDeliveryClaim(text: string): boolean {
  return [
    /\bfrete\s+(?:fica|sai|custa|e|gratis|disponivel|indisponivel)\b/,
    /\b(?:entrega|delivery)\s+(?:disponivel|indisponivel|gratis|e)\b/,
    /\bentregamos\s+(?:em|no|na|nos|nas|para|pra)\b/,
    // "chega amanhã", "entregamos em 2 dias", "chega no dia seguinte" — mas NÃO "troca em X dias"
    /\b(?:entregamos|chega|recebe)\b.{0,40}\b(?:hoje|amanha|dia\s+seguinte|em\s+\d+\s+dias?|ate\s+\w+)\b/,
    // "prazo de entrega", "prazo de chegada" — específico para contexto logístico
    /\b(?:prazo|previsao)\s+(?:de\s+)?(?:entrega|chegada|envio|despacho)\b/,
    // "prazo padrão para o dia seguinte" — mas NÃO "prazo de troca/garantia/devolucao"
    /\bprazo\b(?!.{0,60}\b(?:troca|devolucao|garantia|retorno|reembolso)\b).{0,60}\b(?:dia\s+seguinte|amanha|hoje)\b/,
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

type PolicyClaim =
  | { category: 'installments'; installments?: number }
  | { category: 'payment_method'; methods: string[] }
  | { category: 'exchange_or_return' }
  | { category: 'warranty' }
  | { category: 'business_hours' };

function detectPolicyClaim(text: string): PolicyClaim | null {
  for (const sentence of splitSentences(text)) {
    const normalized = normalizeText(sentence);
    if (mentionsPolicyMeta(normalized)) continue;

    const installments = detectInstallmentClaim(normalized);
    if (installments) return installments;

    const payment = detectPaymentMethodClaim(normalized);
    if (payment) return payment;

    if (mentionsExchangeOrReturnClaim(normalized)) return { category: 'exchange_or_return' };
    if (mentionsWarrantyClaim(normalized)) return { category: 'warranty' };
    if (mentionsBusinessHoursClaim(normalized)) return { category: 'business_hours' };
  }
  return null;
}

function splitSentences(text: string): string[] {
  return text.split(/[.!?\n]+/).map((part) => part.trim()).filter(Boolean);
}

function mentionsPolicyMeta(text: string): boolean {
  return [
    /\b(?:vou|posso|preciso)\s+(?:verificar|confirmar|checar|consultar|olhar)\b/,
    /\bdeixa\s+eu\s+(?:verificar|confirmar|checar|consultar|olhar)\b/,
    /\bnao\s+tenho\s+(?:essa\s+)?(?:informacao|politica|confirmacao)\b/,
    /\bmelhor\s+confirmar\s+com\s+a\s+loja\b/,
    /\b(?:voce|vc)\s+perguntou\s+sobre\b/,
    /\bvou\s+anotar\s+(?:pra|para)\s+(?:te\s+)?(?:responder|confirmar)\b/,
  ].some((pattern) => pattern.test(text));
}

function detectInstallmentClaim(text: string): PolicyClaim | null {
  const times = text.match(/\b(?:ate\s+)?(\d{1,2})\s*x\b/);
  if (times && mentionsInstallmentVerb(text)) return { category: 'installments', installments: Number(times[1]) };

  const longForm = text.match(/\b(?:parcelamos|divide|dividimos|parcela|parcelar)\b.{0,30}\b(\d{1,2})\s+vezes\b/);
  if (longForm) return { category: 'installments', installments: Number(longForm[1]) };

  if (/\b(?:parcelamos|aceita\s+parcelar|pode\s+parcelar|divide|dividimos)\b/.test(text)) {
    return { category: 'installments' };
  }
  return null;
}

function mentionsInstallmentVerb(text: string): boolean {
  return /\b(?:parcelamos|parcela|parcelar|divide|dividimos|vezes|sem\s+juros)\b/.test(text);
}

function detectPaymentMethodClaim(text: string): PolicyClaim | null {
  if (!/\b(?:aceitamos|aceita|trabalhamos\s+com|pode\s+pagar\s+com|pagamento\s+(?:pode|aceito))\b/.test(text)) {
    return null;
  }

  const methods: string[] = [];
  if (/\bpix\b/.test(text)) methods.push('pix');
  if (/\bcart(?:a|ã)o(?:\s+de)?\s+credito\b|\bcredito\b/.test(text)) methods.push('cartao_credito');
  if (/\bcart(?:a|ã)o(?:\s+de)?\s+debito\b|\bdebito\b/.test(text)) methods.push('cartao_debito');
  if (/\bcart(?:a|ã)o\b/.test(text) && !methods.includes('cartao_credito')) methods.push('cartao_credito');
  if (/\bcart(?:a|ã)o\b/.test(text) && !methods.includes('cartao_debito')) methods.push('cartao_debito');
  if (/\bboleto\b/.test(text)) methods.push('boleto');
  if (/\bdinheiro\b/.test(text)) methods.push('dinheiro');

  return methods.length > 0 ? { category: 'payment_method', methods } : null;
}

function mentionsExchangeOrReturnClaim(text: string): boolean {
  return [
    /\b(?:trocamos|troca|pode\s+trocar|aceita\s+troca)\b.{0,40}\b(?:\d+\s+dias?|produto|nota|compra|servir)\b/,
    /\b(?:devolvemos|devolucao|aceita\s+devolucao|pode\s+devolver)\b/,
    /\b(?:tem|sao|voce\s+tem)\s+\d+\s+dias?\s+(?:pra|para)\s+trocar\b/,
  ].some((pattern) => pattern.test(text));
}

function mentionsWarrantyClaim(text: string): boolean {
  return [
    /\b(?:tem|damos|oferecemos|cobre|cobrimos)\s+garantia\b/,
    /\bgarantia\s+(?:de|da|do|cobre|na|para)\b/,
    /\bservico\s+de\s+montagem\s+(?:tem|possui|com)\s+garantia\b/,
  ].some((pattern) => pattern.test(text));
}

function mentionsBusinessHoursClaim(text: string): boolean {
  return [
    /\b(?:abrimos|abre|fechamos|fecha|funcionamos|funciona|atendemos|atende)\b.{0,50}\b(?:\d{1,2}h|domingo|sabado|segunda|sexta|horas?)\b/,
    /\b(?:das|de)\s+\d{1,2}h?\s+(?:as|ate)\s+\d{1,2}h\b/,
    /\baberto\s+(?:no|aos?|de)\s+(?:domingo|sabado|segunda|sexta)\b/,
  ].some((pattern) => pattern.test(text));
}

function policyClaimMismatchesToolResult(claim: PolicyClaim, policyResults: unknown[]): boolean {
  if (claim.category === 'installments' && claim.installments !== undefined) {
    const maxInstallments = collectPolicyNumbers(policyResults, ['installments', 'max_parcelas']);
    return maxInstallments.size > 0 && ![...maxInstallments].some((max) => claim.installments! <= max);
  }

  if (claim.category === 'payment_method' && claim.methods.length > 0) {
    const acceptedMethods = collectAcceptedPaymentMethods(policyResults);
    return acceptedMethods.size > 0 && claim.methods.some((method) => !acceptedMethods.has(method));
  }

  return false;
}

function hasRelevantPolicyEvidence(claim: PolicyClaim, policyResults: unknown[]): boolean {
  const policyKeys = collectPolicyKeys(policyResults);
  if (policyKeys.size === 0) return false;

  if (claim.category === 'installments') return policyKeys.has('parcelamento_maximo');
  if (claim.category === 'payment_method') return policyKeys.has('formas_pagamento_aceitas');
  if (claim.category === 'business_hours') return policyKeys.has('horario_funcionamento');
  if (claim.category === 'warranty') {
    return policyKeys.has('garantia_descricao') || policyKeys.has('prazo_garantia_pneus') || policyKeys.has('politica_montagem');
  }
  if (claim.category === 'exchange_or_return') {
    return policyKeys.has('prazo_troca') || policyKeys.has('politica_devolucao');
  }
  return false;
}

function collectPolicyKeys(policyResults: unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const result of policyResults) collectPolicyKeysFromValue(result, keys, 0);
  return keys;
}

function collectPolicyKeysFromValue(value: unknown, out: Set<string>, depth: number): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPolicyKeysFromValue(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.policy_key === 'string') out.add(record.policy_key);
  for (const nested of Object.values(record)) collectPolicyKeysFromValue(nested, out, depth + 1);
}

function collectPolicyNumbers(policyResults: unknown[], keys: string[]): Set<number> {
  const numbers = new Set<number>();
  for (const result of policyResults) collectNumbersForKeys(result, keys, numbers, 0);
  return numbers;
}

function collectNumbersForKeys(value: unknown, keys: string[], out: Set<number>, depth: number): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectNumbersForKeys(item, keys, out, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) out.add(candidate);
  }
  for (const nested of Object.values(record)) collectNumbersForKeys(nested, keys, out, depth + 1);
}

function collectAcceptedPaymentMethods(policyResults: unknown[]): Set<string> {
  const methods = new Set<string>();
  for (const result of policyResults) collectPaymentMethods(result, methods, 0);
  return methods;
}

function collectPaymentMethods(value: unknown, out: Set<string>, depth: number): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') out.add(normalizePaymentMethod(item));
      else collectPaymentMethods(item, out, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  for (const key of ['policy_value', 'aceitos', 'formas_pagamento_aceitas']) {
    collectPaymentMethods(record[key], out, depth + 1);
  }
}

function normalizePaymentMethod(value: string): string {
  const normalized = normalizeText(value).replace(/[\s-]+/g, '_');
  if (normalized === 'cartao' || normalized === 'cartao_credito') return 'cartao_credito';
  if (normalized === 'cartao_debito') return 'cartao_debito';
  return normalized;
}

function hasApproxAmount(values: Set<number>, amount: number): boolean {
  for (const value of values) {
    if (Math.abs(value - amount) < 0.01) return true;
  }
  return false;
}
