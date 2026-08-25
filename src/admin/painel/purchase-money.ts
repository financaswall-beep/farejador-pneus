import { moneyCents } from './stage5-integrity.js';

// commerce.wholesale_purchases.total_amount e NUMERIC(12,2): dez digitos
// inteiros e dois centavos. Validamos antes do INSERT para nunca devolver um
// numeric field overflow ao usuario.
export const MAX_WHOLESALE_PURCHASE_CENTS = 999_999_999_999;

export interface PurchaseMoneyItem {
  quantity: number;
  unit_cost: number;
}

export interface PurchaseMoneyTotals {
  productsCents: number;
  freightCents: number;
  discountCents: number;
  totalCents: number;
  allocatedItemCents: number[];
}

export function hasCentPrecision(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const scaled = value * 100;
  return Math.abs(scaled - Math.round(scaled)) < 1e-7;
}

export function assertWholesalePurchaseMoney(items: PurchaseMoneyItem[]): number {
  let totalCents = 0;
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 100_000) {
      throw new Error('purchase_quantity_invalid');
    }
    if (!Number.isFinite(item.unit_cost) || item.unit_cost < 0
      || item.unit_cost > 9_999_999.99) {
      throw new Error('purchase_unit_cost_invalid');
    }
    if (!hasCentPrecision(item.unit_cost)) {
      throw new Error('unit_cost_cent_precision');
    }
    const lineCents = moneyCents(item.unit_cost) * item.quantity;
    if (!Number.isSafeInteger(lineCents) || lineCents > MAX_WHOLESALE_PURCHASE_CENTS) {
      throw new Error('purchase_line_total_too_large');
    }
    totalCents += lineCents;
    if (!Number.isSafeInteger(totalCents) || totalCents > MAX_WHOLESALE_PURCHASE_CENTS) {
      throw new Error('purchase_total_too_large');
    }
  }
  return totalCents;
}

function moneyPart(value: number | undefined, errorCode: string): number {
  const normalized = value ?? 0;
  if (!Number.isFinite(normalized) || normalized < 0 || !hasCentPrecision(normalized)) {
    throw new Error(errorCode);
  }
  return moneyCents(normalized);
}

/**
 * Fecha a compra em centavos e rateia frete/desconto por valor dos itens.
 * O maior-resto torna o rateio determinístico e garante que a soma dos itens
 * seja exatamente igual ao total financeiro, sem centavo perdido.
 */
export function calculateWholesalePurchaseMoney(
  items: PurchaseMoneyItem[],
  freight = 0,
  discount = 0,
): PurchaseMoneyTotals {
  const productsCents = assertWholesalePurchaseMoney(items);
  const freightCents = moneyPart(freight, 'freight_amount_invalid');
  const discountCents = moneyPart(discount, 'discount_amount_invalid');
  if (discountCents > productsCents + freightCents) {
    throw new Error('discount_exceeds_purchase');
  }
  const totalCents = productsCents + freightCents - discountCents;
  if (!Number.isSafeInteger(totalCents) || totalCents > MAX_WHOLESALE_PURCHASE_CENTS) {
    throw new Error('purchase_total_too_large');
  }
  const weights = items.map((item) => moneyCents(item.unit_cost) * item.quantity);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const fallbackTotal = items.reduce((sum, item) => sum + item.quantity, 0);
  const raw = items.map((item, index) => {
    const numerator = totalCents * (weightTotal > 0 ? weights[index]! : item.quantity);
    const denominator = weightTotal > 0 ? weightTotal : fallbackTotal;
    const base = denominator > 0 ? Math.floor(numerator / denominator) : 0;
    return { index, base, remainder: denominator > 0 ? numerator % denominator : 0 };
  });
  let missing = totalCents - raw.reduce((sum, row) => sum + row.base, 0);
  for (const row of [...raw].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (missing <= 0) break;
    row.base += 1;
    missing -= 1;
  }
  if (missing !== 0) throw new Error('purchase_allocation_failed');
  return {
    productsCents, freightCents, discountCents, totalCents,
    allocatedItemCents: raw.sort((a, b) => a.index - b.index).map((row) => row.base),
  };
}
