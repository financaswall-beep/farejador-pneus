import { moneyCents } from './stage5-integrity.js';

// commerce.orders/order_items usam NUMERIC(10,2): oito algarismos inteiros.
export const MAX_RETAIL_SALE_CENTS = 9_999_999_999;

// commerce.wholesale_orders/wholesale_order_items usam NUMERIC(12,2): dez
// algarismos inteiros. O limite vale tanto para cada linha quanto para o pedido.
export const MAX_WHOLESALE_SALE_CENTS = 999_999_999_999;

export interface RetailSaleMoneyItem {
  quantity: number;
  unit_price: number;
  discount_amount?: number;
}

export interface WholesaleSaleMoneyItem {
  quantity: number;
  unit_price: number;
}

export function hasCentPrecision(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const scaled = value * 100;
  return Math.abs(scaled - Math.round(scaled)) < 1e-7;
}

export function assertRetailSaleMoney(items: RetailSaleMoneyItem[]): number {
  if (items.length === 0) throw new Error('sale_items_required');
  if (items.length > 100) throw new Error('sale_items_limit');
  let totalCents = 0;
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 100_000) {
      throw new Error('sale_quantity_invalid');
    }
    if (!Number.isFinite(item.unit_price) || item.unit_price < 0
      || item.unit_price > 99_999_999.99) {
      throw new Error('sale_unit_price_invalid');
    }
    if (!hasCentPrecision(item.unit_price)) throw new Error('unit_price_cent_precision');

    const discount = item.discount_amount ?? 0;
    if (!Number.isFinite(discount) || discount < 0 || discount > 99_999_999.99) {
      throw new Error('sale_discount_invalid');
    }
    if (!hasCentPrecision(discount)) throw new Error('discount_cent_precision');

    const grossCents = moneyCents(item.unit_price) * item.quantity;
    if (!Number.isSafeInteger(grossCents) || grossCents > MAX_RETAIL_SALE_CENTS) {
      throw new Error('sale_line_total_too_large');
    }
    const discountCents = moneyCents(discount);
    if (discountCents > grossCents) throw new Error('discount_exceeds_line_total');
    const lineCents = grossCents - discountCents;
    totalCents += lineCents;
    if (!Number.isSafeInteger(totalCents) || totalCents > MAX_RETAIL_SALE_CENTS) {
      throw new Error('sale_total_too_large');
    }
  }
  return totalCents;
}

export function assertWholesaleSaleMoney(items: WholesaleSaleMoneyItem[]): number {
  if (items.length === 0) throw new Error('items_required');
  if (items.length > 50) throw new Error('sale_items_limit');
  let totalCents = 0;
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 100_000) {
      throw new Error('quantity_invalid');
    }
    if (!Number.isFinite(item.unit_price) || item.unit_price < 0
      || item.unit_price > 9_999_999.99) {
      throw new Error('price_invalid');
    }
    if (!hasCentPrecision(item.unit_price)) throw new Error('unit_price_cent_precision');
    const lineCents = moneyCents(item.unit_price) * item.quantity;
    if (!Number.isSafeInteger(lineCents) || lineCents > MAX_WHOLESALE_SALE_CENTS) {
      throw new Error('sale_line_total_too_large');
    }
    totalCents += lineCents;
    if (!Number.isSafeInteger(totalCents) || totalCents > MAX_WHOLESALE_SALE_CENTS) {
      throw new Error('sale_total_too_large');
    }
  }
  return totalCents;
}
