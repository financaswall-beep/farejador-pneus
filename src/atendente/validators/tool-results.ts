import type { ToolName } from '../planner/schemas.js';

const MAX_COLLECT_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;

export interface ToolResultForValidation {
  tool: ToolName;
  ok: boolean;
  output: unknown;
}

export function collectToolProductIds(results: ToolResultForValidation[]): Set<string> {
  const ids = new Set<string>();
  for (const result of results.filter((item) => item.ok)) {
    collectProductIds(result.output, ids);
  }
  return ids;
}

export function collectToolPrices(results: ToolResultForValidation[]): Set<number> {
  const prices = new Set<number>();
  for (const result of results.filter((item) => item.ok)) {
    collectPrices(result.output, prices);
  }
  return prices;
}

export function collectDeliveryFees(results: ToolResultForValidation[]): Set<number> {
  const fees = new Set<number>();
  for (const result of results.filter((item) => item.ok && item.tool === 'calcularFrete')) {
    collectFieldNumbers(result.output, 'valor', fees, 0);
  }
  return fees;
}

/**
 * Extrai valores monetários (R$) dos textos de políticas comerciais retornadas
 * por buscarPoliticaComercial. Usado para permitir que o Generator repita
 * preços/taxas que estão explicitamente na política (ex.: montagem R$15).
 */
export function collectPolicyMoney(results: ToolResultForValidation[]): Set<number> {
  const amounts = new Set<number>();
  for (const result of results.filter((item) => item.ok && item.tool === 'buscarPoliticaComercial')) {
    extractMoneyFromValue(result.output, amounts);
  }
  return amounts;
}

function extractMoneyFromValue(value: unknown, out: Set<number>): void {
  if (typeof value === 'string') {
    const pattern = /r\$\s*((?:\d{1,3}(?:\.\d{3})+)|\d+)(?:,(\d{2}))?/gi;
    for (const match of value.matchAll(pattern)) {
      const whole = match[1]?.replace(/\./g, '');
      if (!whole) continue;
      const cents = match[2] ?? '00';
      const amount = Number(`${whole}.${cents}`);
      if (Number.isFinite(amount)) out.add(amount);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractMoneyFromValue(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      extractMoneyFromValue(nested, out);
    }
  }
}

export function hasStockEvidence(results: ToolResultForValidation[]): boolean {
  return results.some(
    (result) => result.ok && result.tool === 'verificarEstoque' && hasNonEmptyOutput(result.output),
  );
}

export function hasDeliveryEvidence(results: ToolResultForValidation[]): boolean {
  return results.some(
    (result) => result.ok && result.tool === 'calcularFrete' && hasNonEmptyOutput(result.output),
  );
}

export function hasCompatibilityEvidence(results: ToolResultForValidation[]): boolean {
  return results.some(
    (result) =>
      result.ok &&
      result.tool === 'buscarCompatibilidade' &&
      hasNonEmptyCompatibilityOutput(result.output),
  );
}

export function collectPolicyResults(results: ToolResultForValidation[]): unknown[] {
  return results
    .filter((result) => result.ok && result.tool === 'buscarPoliticaComercial' && hasNonEmptyOutput(result.output))
    .flatMap((result) => (Array.isArray(result.output) ? result.output : [result.output]));
}

function collectProductIds(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > MAX_COLLECT_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) collectProductIds(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.product_id === 'string') out.add(record.product_id);
  for (const nested of Object.values(record)) collectProductIds(nested, out, depth + 1);
}

function collectPrices(value: unknown, out: Set<number>): void {
  collectFieldNumbers(value, 'price_amount', out, 0);
  collectFieldNumbers(value, 'current_price', out, 0);
}

function hasNonEmptyOutput(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function hasNonEmptyCompatibilityOutput(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const produtos = (item as Record<string, unknown>).produtos;
    return Array.isArray(produtos) && produtos.length > 0;
  });
}

function collectFieldNumbers(value: unknown, field: string, out: Set<number>, depth: number): void {
  if (depth > MAX_COLLECT_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) collectFieldNumbers(item, field, out, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record[field] === 'string' || typeof record[field] === 'number') {
    const parsed = Number(record[field]);
    if (Number.isFinite(parsed)) out.add(parsed);
  }
  for (const nested of Object.values(record)) collectFieldNumbers(nested, field, out, depth + 1);
}
