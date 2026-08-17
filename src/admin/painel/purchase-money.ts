import { moneyCents } from './stage5-integrity.js';

// commerce.wholesale_purchases.total_amount e NUMERIC(12,2): dez digitos
// inteiros e dois centavos. Validamos antes do INSERT para nunca devolver um
// numeric field overflow ao usuario.
export const MAX_WHOLESALE_PURCHASE_CENTS = 999_999_999_999;

export interface PurchaseMoneyItem {
  quantity: number;
  unit_cost: number;
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
