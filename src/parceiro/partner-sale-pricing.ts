import type { PoolClient } from 'pg';
import { moneyCents } from '../shared/catalog-pricing.js';
import type { PartnerContext } from './auth.js';

export interface PartnerSalePricedItem {
  partner_stock_id: string;
  reference_unit_price?: number;
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
