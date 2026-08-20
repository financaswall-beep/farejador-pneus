import { moneyCents } from '../shared/catalog-pricing.js';
import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';

export class OperationStockPriceError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export async function setPartnerOperationStockPrice(
  ctx: PartnerContext,
  actorLabel: string,
  stockId: string,
  salePrice: number,
  reason: string,
): Promise<{ changed: boolean; stock_id: string; sale_price: number }> {
  const normalizedReason = reason.trim();
  if (!Number.isFinite(salePrice) || salePrice <= 0
    || Math.abs(salePrice * 100 - moneyCents(salePrice)) >= 1e-7) {
    throw new OperationStockPriceError('stock_sale_price_invalid', 400);
  }
  if (normalizedReason.length < 3) {
    throw new OperationStockPriceError('stock_sale_price_reason_required', 400);
  }

  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const selected = await client.query<{ sale_price: string | null; item_name: string }>(
      `SELECT sale_price::text,item_name
         FROM commerce.partner_stock_levels
        WHERE id=$1 AND environment=$2 AND unit_id=$3 AND deleted_at IS NULL
        FOR UPDATE`,
      [stockId, ctx.environment, ctx.unitId],
    );
    const row = selected.rows[0];
    if (!row) throw new OperationStockPriceError('stock_not_found', 404);
    const before = row.sale_price == null ? null : Number(row.sale_price);
    const normalizedPrice = moneyCents(salePrice) / 100;
    if (before !== null && moneyCents(before) === moneyCents(normalizedPrice)) {
      return { changed: false, stock_id: stockId, sale_price: before };
    }

    await client.query(
      `UPDATE commerce.partner_stock_levels
          SET sale_price=$4,updated_by=$5,updated_at=now()
        WHERE id=$1 AND environment=$2 AND unit_id=$3`,
      [stockId, ctx.environment, ctx.unitId, normalizedPrice, actorLabel],
    );
    await client.query(
      `INSERT INTO audit.events (
         environment,domain,entity_table,entity_id,event_type,actor_label,
         payload_before,payload_after
       ) VALUES ($1,'stock','commerce.partner_stock_levels',$2,
                 'partner_stock_sale_price_changed',$3,$4::jsonb,$5::jsonb)`,
      [
        ctx.environment,
        stockId,
        actorLabel,
        JSON.stringify({ sale_price: before }),
        JSON.stringify({
          stock_id: stockId,
          item_name: row.item_name,
          sale_price: normalizedPrice,
          reason: normalizedReason,
        }),
      ],
    );
    return { changed: true, stock_id: stockId, sale_price: normalizedPrice };
  });
}
