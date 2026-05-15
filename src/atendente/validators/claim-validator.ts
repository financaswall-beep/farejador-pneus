/**
 * ClaimValidator — Etapa 2 (2026-05-15)
 *
 * Em vez de regex tentar entender o texto do Atendente ("tem em estoque",
 * "serve na sua Bros", "fica R$ 79"), o Generator emite junto da resposta
 * uma lista de `claims` estruturados — afirmacoes comerciais que ele esta
 * fazendo. O validator checa cada claim contra os tool_results do turn.
 *
 * Regras (uma por tipo de claim):
 *
 *   price                → buscarProduto retornou produto com price_amount
 *                          aproximadamente igual (±R$0,01)
 *   stock_availability   → verificarEstoque retornou disponivel=true
 *                          OU quantidade_total > 0
 *   fitment              → buscarCompatibilidade retornou pelo menos 1
 *                          fitment com array de produtos nao-vazio
 *   delivery_fee         → calcularFrete retornou valor; se claim.amount
 *                          informado, valor casa (±R$0,01)
 *
 * Se um claim falha, o turn eh bloqueado com reason `claim_invalid:{type}:{detail}`.
 *
 * Migracao: claims default=[] no Generator. Turn que nao emite nenhum claim
 * passa pelo validator (nada para validar). Quando emite, validator
 * enforce. Roda em PARALELO ao say-validator regex durante transicao —
 * qualquer um pode bloquear.
 */

import type { GeneratorClaim } from '../generator/schemas.js';
import type { ToolResultForValidation } from './tool-results.js';

export type ClaimValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

const MONEY_TOLERANCE = 0.01;

export function validateClaims(
  claims: GeneratorClaim[],
  toolResults: ToolResultForValidation[],
): ClaimValidationResult {
  for (const claim of claims) {
    const result = validateClaim(claim, toolResults);
    if (!result.valid) return result;
  }
  return { valid: true };
}

function validateClaim(
  claim: GeneratorClaim,
  toolResults: ToolResultForValidation[],
): ClaimValidationResult {
  switch (claim.type) {
    case 'price':
      return validatePriceClaim(claim, toolResults);
    case 'stock_availability':
      return validateStockClaim(claim, toolResults);
    case 'fitment':
      return validateFitmentClaim(claim, toolResults);
    case 'delivery_fee':
      return validateDeliveryFeeClaim(claim, toolResults);
  }
}

function validatePriceClaim(
  claim: Extract<GeneratorClaim, { type: 'price' }>,
  toolResults: ToolResultForValidation[],
): ClaimValidationResult {
  const products = collectProductsFromBuscarProduto(toolResults);
  if (products.length === 0) {
    return { valid: false, reason: 'claim_invalid:price:no_buscarProduto_tool_result' };
  }

  // Se product_id informado, restringe checagem a esse produto.
  const candidates = claim.product_id
    ? products.filter((p) => p.product_id === claim.product_id)
    : products;

  if (claim.product_id && candidates.length === 0) {
    return {
      valid: false,
      reason: `claim_invalid:price:product_id_not_in_results:${claim.product_id}`,
    };
  }

  const matched = candidates.some((p) => moneyApproxEqual(p.price_amount, claim.amount));
  if (!matched) {
    return {
      valid: false,
      reason: `claim_invalid:price:amount_${claim.amount}_not_in_results`,
    };
  }
  return { valid: true };
}

function validateStockClaim(
  claim: Extract<GeneratorClaim, { type: 'stock_availability' }>,
  toolResults: ToolResultForValidation[],
): ClaimValidationResult {
  const stocks = collectStocksFromVerificarEstoque(toolResults);
  if (stocks.length === 0) {
    return { valid: false, reason: 'claim_invalid:stock_availability:no_verificarEstoque_tool_result' };
  }

  const candidates = claim.product_id
    ? stocks.filter((s) => s.product_id === claim.product_id)
    : stocks;

  if (claim.product_id && candidates.length === 0) {
    return {
      valid: false,
      reason: `claim_invalid:stock_availability:product_id_not_in_results:${claim.product_id}`,
    };
  }

  const available = candidates.some((s) => s.disponivel === true || (s.quantidade_total ?? 0) > 0);
  if (!available) {
    return { valid: false, reason: 'claim_invalid:stock_availability:not_available' };
  }
  return { valid: true };
}

function validateFitmentClaim(
  claim: Extract<GeneratorClaim, { type: 'fitment' }>,
  toolResults: ToolResultForValidation[],
): ClaimValidationResult {
  const fitments = collectFitmentsFromBuscarCompatibilidade(toolResults);
  if (fitments.length === 0) {
    return { valid: false, reason: 'claim_invalid:fitment:no_buscarCompatibilidade_tool_result' };
  }

  // Pelo menos 1 fitment com produtos compativeis
  const anyValid = fitments.some((f) => Array.isArray(f.produtos) && f.produtos.length > 0);
  if (!anyValid) {
    return { valid: false, reason: 'claim_invalid:fitment:no_compatible_products' };
  }

  // Se product_id informado, exige que algum fitment liste esse produto
  if (claim.product_id) {
    const found = fitments.some((f) =>
      Array.isArray(f.produtos) &&
      f.produtos.some((p) => p && typeof p === 'object' && (p as Record<string, unknown>).product_id === claim.product_id),
    );
    if (!found) {
      return {
        valid: false,
        reason: `claim_invalid:fitment:product_id_not_in_results:${claim.product_id}`,
      };
    }
  }
  return { valid: true };
}

function validateDeliveryFeeClaim(
  claim: Extract<GeneratorClaim, { type: 'delivery_fee' }>,
  toolResults: ToolResultForValidation[],
): ClaimValidationResult {
  const freights = collectFreightsFromCalcularFrete(toolResults);
  if (freights.length === 0) {
    return { valid: false, reason: 'claim_invalid:delivery_fee:no_calcularFrete_tool_result' };
  }

  if (claim.amount === null || claim.amount === undefined) {
    // claim sem valor especifico — basta ter frete calculado e disponivel
    const hasAvailable = freights.some((f) => f.disponivel === true);
    if (!hasAvailable) {
      return { valid: false, reason: 'claim_invalid:delivery_fee:no_available_freight' };
    }
    return { valid: true };
  }

  const matched = freights.some((f) => moneyApproxEqual(f.valor, claim.amount!));
  if (!matched) {
    return {
      valid: false,
      reason: `claim_invalid:delivery_fee:amount_${claim.amount}_not_in_results`,
    };
  }
  return { valid: true };
}

// ------------------------------------------------------------------
// Coletores de evidencia — leem tool_results e extraem campos relevantes.
// ------------------------------------------------------------------

interface ProductEvidence {
  product_id?: unknown;
  price_amount: number | null;
}

function collectProductsFromBuscarProduto(toolResults: ToolResultForValidation[]): ProductEvidence[] {
  const products: ProductEvidence[] = [];
  for (const result of toolResults) {
    if (!result.ok || result.tool !== 'buscarProduto' || !Array.isArray(result.output)) continue;
    for (const product of result.output) {
      if (!product || typeof product !== 'object') continue;
      const item = product as Record<string, unknown>;
      products.push({
        product_id: item.product_id,
        price_amount: parseMoney(item.price_amount),
      });
    }
  }
  return products;
}

interface StockEvidence {
  product_id?: unknown;
  disponivel?: boolean;
  quantidade_total?: number;
}

function collectStocksFromVerificarEstoque(toolResults: ToolResultForValidation[]): StockEvidence[] {
  const stocks: StockEvidence[] = [];
  for (const result of toolResults) {
    if (!result.ok || result.tool !== 'verificarEstoque' || !result.output) continue;
    if (typeof result.output !== 'object' || Array.isArray(result.output)) continue;
    const item = result.output as Record<string, unknown>;
    stocks.push({
      product_id: item.product_id,
      disponivel: typeof item.disponivel === 'boolean' ? item.disponivel : undefined,
      quantidade_total: typeof item.quantidade_total === 'number' ? item.quantidade_total : undefined,
    });
  }
  return stocks;
}

interface FitmentEvidence {
  produtos: unknown[];
}

function collectFitmentsFromBuscarCompatibilidade(toolResults: ToolResultForValidation[]): FitmentEvidence[] {
  const fitments: FitmentEvidence[] = [];
  for (const result of toolResults) {
    if (!result.ok || result.tool !== 'buscarCompatibilidade' || !Array.isArray(result.output)) continue;
    for (const fitment of result.output) {
      if (!fitment || typeof fitment !== 'object') continue;
      const produtos = (fitment as Record<string, unknown>).produtos;
      fitments.push({ produtos: Array.isArray(produtos) ? produtos : [] });
    }
  }
  return fitments;
}

interface FreightEvidence {
  disponivel?: boolean;
  valor: number | null;
}

function collectFreightsFromCalcularFrete(toolResults: ToolResultForValidation[]): FreightEvidence[] {
  const freights: FreightEvidence[] = [];
  for (const result of toolResults) {
    if (!result.ok || result.tool !== 'calcularFrete' || !result.output) continue;
    if (typeof result.output !== 'object' || Array.isArray(result.output)) continue;
    const item = result.output as Record<string, unknown>;
    freights.push({
      disponivel: typeof item.disponivel === 'boolean' ? item.disponivel : undefined,
      valor: parseMoney(item.valor),
    });
  }
  return freights;
}

function parseMoney(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.,-]/g, '').replace(',', '.');
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function moneyApproxEqual(a: number | null, b: number): boolean {
  if (a === null) return false;
  return Math.abs(a - b) < MONEY_TOLERANCE;
}
