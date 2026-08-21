import type { PoolClient } from 'pg';
import { moneyCents } from '../shared/catalog-pricing.js';
import type { PartnerContext } from './auth.js';

export interface PartnerSalePricedItem {
  partner_stock_id: string;
  reference_unit_price?: number;
}

export interface PartnerSaleMoneyItem {
  quantity: number;
  unit_price: number;
  discount_amount?: number;
}

const PARTNER_SALE_MAX_CENTS = 9_999_999_999;

function exactMoneyCents(value: number, field: string): number {
  const cents = moneyCents(value);
  if (!Number.isFinite(value) || value < 0
      || Math.abs(value * 100 - cents) >= 1e-7) {
    throw new Error(`${field}_invalid`);
  }
  return cents;
}

/**
 * Calcula o mesmo total da function SQL, mas em centavos e antes de qualquer
 * efeito no estoque. Impede desconto maior que a linha, total zerado e overflow
 * do NUMERIC(10,2) de partner_orders.
 */
export function partnerSaleTotalCents(
  items: PartnerSaleMoneyItem[],
  orderDiscount = 0,
  freight = 0,
): number {
  if (!items.length) throw new Error('partner_sale_items_required');
  let itemNetCents = 0;
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 999_999) {
      throw new Error('partner_sale_quantity_invalid');
    }
    const unitCents = exactMoneyCents(item.unit_price, 'partner_sale_unit_price');
    if (unitCents <= 0) throw new Error('partner_sale_unit_price_invalid');
    const discountCents = exactMoneyCents(item.discount_amount ?? 0, 'partner_sale_item_discount');
    const grossCents = item.quantity * unitCents;
    if (!Number.isSafeInteger(grossCents) || discountCents > grossCents) {
      throw new Error('partner_sale_item_discount_exceeds_line');
    }
    itemNetCents += grossCents - discountCents;
    if (!Number.isSafeInteger(itemNetCents) || itemNetCents > PARTNER_SALE_MAX_CENTS) {
      throw new Error('partner_sale_total_too_large');
    }
  }
  const orderDiscountCents = exactMoneyCents(orderDiscount, 'partner_sale_discount');
  const freightCents = exactMoneyCents(freight, 'partner_sale_freight');
  const totalCents = itemNetCents - orderDiscountCents + freightCents;
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    throw new Error('partner_sale_total_must_be_positive');
  }
  if (totalCents > PARTNER_SALE_MAX_CENTS) throw new Error('partner_sale_total_too_large');
  return totalCents;
}

/** Trava o preço oficial durante o fechamento e recusa catálogo obsoleto. */
export async function lockAndValidatePartnerSalePrices(
  client: Pick<PoolClient, 'query'>,
  ctx: PartnerContext,
  items: PartnerSalePricedItem[],
): Promise<void> {
  const stockIds = [...new Set(items.map((item) => item.partner_stock_id))];
  const result = await client.query<{ id: string; sale_price: string | null }>(
    `SELECT id,sale_price::text
       FROM commerce.partner_stock_levels
      WHERE environment=$1 AND unit_id=$2 AND id=ANY($3::uuid[])
        AND deleted_at IS NULL
      ORDER BY id
      FOR UPDATE`,
    [ctx.environment, ctx.unitId, stockIds],
  );
  const priceByStock = new Map(result.rows.map((row) => [
    row.id, row.sale_price == null ? null : Number(row.sale_price),
  ]));
  for (const item of items) {
    if (!priceByStock.has(item.partner_stock_id)) {
      throw new Error('Item de estoque nao pertence a esta unidade.');
    }
    const official = priceByStock.get(item.partner_stock_id);
    if (official == null || official <= 0) throw new Error('partner_sale_price_missing');
    if (item.reference_unit_price !== undefined
      && moneyCents(item.reference_unit_price) !== moneyCents(official)) {
      throw new Error('partner_sale_price_changed');
    }
  }
}
