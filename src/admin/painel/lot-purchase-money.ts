import { calculateWholesalePurchaseMoney, hasCentPrecision } from './purchase-money.js';

export interface PurchaseLotInput {
  description: string;
  quantity: number;
  total_cost: number;
}

/** The total is authoritative: never round a per-tire quotient and multiply it back. */
export function calculateLotPurchaseMoney(lot: PurchaseLotInput, freight = 0, discount = 0) {
  if (!lot.description?.trim() || lot.description.trim().length > 200) {
    throw new Error('lot_description_required');
  }
  if (!Number.isInteger(lot.quantity) || lot.quantity <= 0 || lot.quantity > 100_000) {
    throw new Error('purchase_quantity_invalid');
  }
  if (!Number.isFinite(lot.total_cost) || lot.total_cost <= 0
    || lot.total_cost > 9_999_999.99 || !hasCentPrecision(lot.total_cost)) {
    throw new Error('lot_total_cost_invalid');
  }
  return calculateWholesalePurchaseMoney([{ quantity: 1, unit_cost: lot.total_cost }], freight, discount);
}
