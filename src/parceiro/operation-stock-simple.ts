import type { PoolClient } from 'pg';
import { moneyCents } from '../shared/catalog-pricing.js';
import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';
import { resolveCatalogProductForStock } from './operation-stock-catalog-link.js';

export type SimpleTireCondition = 'novo' | 'meia_vida' | 'remold';

export interface SimpleTireInput {
  tire_size: string;
  tire_width_mm: number;
  tire_aspect_ratio: number;
  tire_rim_diameter: number;
  brand: string;
  tire_condition: SimpleTireCondition;
  quantity_on_hand: number;
  minimum_quantity?: number | null;
  sale_price: number;
}

export class OperationStockSimpleError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

function normalizedPrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0
    || Math.abs(value * 100 - moneyCents(value)) >= 1e-7) {
    throw new OperationStockSimpleError('stock_sale_price_invalid', 400);
  }
  return moneyCents(value) / 100;
}

async function audit(
  client: PoolClient,
  ctx: PartnerContext,
  stockId: string,
  eventType: string,
  actor: string,
  before: object | null,
  after: object,
): Promise<void> {
  await client.query(
    `INSERT INTO audit.events (
       environment,domain,entity_table,entity_id,event_type,actor_label,
       payload_before,payload_after
     ) VALUES ($1,'stock','commerce.partner_stock_levels',$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [ctx.environment, stockId, eventType, actor,
      before == null ? null : JSON.stringify(before), JSON.stringify(after)],
  );
}

export async function getSimpleOperationStockPrices(
  ctx: PartnerContext,
): Promise<Array<{ stock_id: string; sale_price: number | null }>> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ stock_id: string; sale_price: string | null }>(
      `SELECT id AS stock_id,sale_price::text
         FROM commerce.partner_stock_levels
        WHERE environment=$1 AND unit_id=$2 AND deleted_at IS NULL
          AND item_type<>'servico'
        ORDER BY item_name,brand NULLS LAST`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows.map((row) => ({
      stock_id: row.stock_id,
      sale_price: row.sale_price == null ? null : Number(row.sale_price),
    }));
  });
}

export async function createSimpleOperationTire(
  ctx: PartnerContext,
  actor: string,
  input: SimpleTireInput,
): Promise<{ stock_id: string; quantity_on_hand: number; sale_price: number }> {
  const brand = input.brand.trim();
  const salePrice = normalizedPrice(input.sale_price);
  try {
    return await withPartnerContext(ctx.partnerUnitId, async (client) => {
      const duplicate = await client.query<{ id: string }>(
        `SELECT id
           FROM commerce.partner_stock_levels
          WHERE environment=$1 AND unit_id=$2 AND deleted_at IS NULL
            AND item_type='pneu'
            AND lower(trim(tire_size))=lower(trim($3))
            AND lower(trim(COALESCE(brand,'')))=lower(trim($4))
            AND tire_condition=$5
          LIMIT 1 FOR UPDATE`,
        [ctx.environment, ctx.unitId, input.tire_size, brand, input.tire_condition],
      );
      if (duplicate.rows[0]) {
        throw new OperationStockSimpleError('stock_item_already_exists', 409);
      }

      const productId = await resolveCatalogProductForStock(client, ctx, {
        item_type: 'pneu', tire_size: input.tire_size, brand,
        tire_condition: input.tire_condition,
      });
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO commerce.partner_stock_levels (
           environment,unit_id,product_id,item_name,item_type,tire_size,
           tire_width_mm,tire_aspect_ratio,tire_rim_diameter,brand,
           quantity_on_hand,minimum_quantity,average_cost,sale_price,
           tire_condition,is_tracked,stock_status,updated_by
         ) VALUES (
           $1,$2,$3,$4,'pneu',$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,true,
           commerce.partner_stock_status($9,0,$10,true),$13
         ) RETURNING id`,
        [ctx.environment, ctx.unitId, productId, input.tire_size,
          input.tire_width_mm, input.tire_aspect_ratio, input.tire_rim_diameter,
          brand, input.quantity_on_hand, input.minimum_quantity ?? null,
          salePrice, input.tire_condition, actor],
      );
      const stockId = inserted.rows[0]!.id;
      await audit(client, ctx, stockId, 'stock_item_created', actor, null, {
        stock_id: stockId, item_name: input.tire_size, brand,
        tire_condition: input.tire_condition,
        quantity_on_hand: input.quantity_on_hand, sale_price: salePrice,
        product_id: productId,
      });
      return { stock_id: stockId, quantity_on_hand: input.quantity_on_hand, sale_price: salePrice };
    });
  } catch (error) {
    if (error instanceof OperationStockSimpleError) throw error;
    if ((error as { code?: string }).code === '23505') {
      throw new OperationStockSimpleError('stock_item_already_exists', 409);
    }
    throw error;
  }
}

export async function correctSimpleOperationStockBalance(
  ctx: PartnerContext,
  actor: string,
  stockId: string,
  quantity: number,
): Promise<{ changed: boolean; stock_id: string; quantity_on_hand: number }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const selected = await client.query<{
      item_name: string; item_type: string; quantity_on_hand: number | null;
      quantity_reserved: number; minimum_quantity: number | null; is_tracked: boolean;
    }>(
      `SELECT item_name,item_type,quantity_on_hand,quantity_reserved,
              minimum_quantity,is_tracked
         FROM commerce.partner_stock_levels
        WHERE id=$1 AND environment=$2 AND unit_id=$3 AND deleted_at IS NULL
        FOR UPDATE`,
      [stockId, ctx.environment, ctx.unitId],
    );
    const row = selected.rows[0];
    if (!row || row.item_type === 'servico' || !row.is_tracked) {
      throw new OperationStockSimpleError('stock_not_found', 404);
    }
    if (quantity < Number(row.quantity_reserved || 0)) {
      throw new OperationStockSimpleError('stock_balance_below_reserved', 409);
    }
    if (Number(row.quantity_on_hand || 0) === quantity) {
      return { changed: false, stock_id: stockId, quantity_on_hand: quantity };
    }

    await client.query(
      `UPDATE commerce.partner_stock_levels
          SET quantity_on_hand=$4,
              stock_status=commerce.partner_stock_status(
                $4,quantity_reserved,minimum_quantity,is_tracked
              ),
              updated_by=$5,updated_at=now()
        WHERE id=$1 AND environment=$2 AND unit_id=$3`,
      [stockId, ctx.environment, ctx.unitId, quantity, actor],
    );
    await audit(client, ctx, stockId, 'partner_stock_count_approved', actor,
      { quantity_on_hand: row.quantity_on_hand }, {
        stock_id: stockId, item_name: row.item_name,
        quantity_before: row.quantity_on_hand, quantity_after: quantity,
        reason: 'Saldo informado na tela simples de estoque',
      });
    return { changed: true, stock_id: stockId, quantity_on_hand: quantity };
  });
}
