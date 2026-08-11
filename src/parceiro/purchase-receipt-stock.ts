import type { PoolClient } from 'pg';
import type { PartnerContext } from './auth.js';
import type { TireCondition } from '../shared/tire-condition.js';

export interface PurchaseReceiptItem {
  id: string;
  product_id: string | null;
  item_name: string;
  quantity: number;
  unit_cost: string | number;
  tire_size: string | null;
  tire_width_mm: number | null;
  tire_aspect_ratio: number | null;
  tire_rim_diameter: number | null;
  brand: string | null;
  sale_price: string | number | null;
  tire_condition: TireCondition | null;
}

export interface PurchaseReceiptMove {
  stock_id: string;
  item_id: string;
  received_quantity: number;
  new_qty: number;
  new_status: string;
}

interface StockRow {
  stock_id: string;
  quantity_on_hand: number | null;
  average_cost: string | null;
}

function clean(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function findStock(
  client: PoolClient,
  ctx: PartnerContext,
  item: PurchaseReceiptItem,
  supplierName: string | null,
): Promise<StockRow | null> {
  const result = await client.query<StockRow>(
    `SELECT id AS stock_id, quantity_on_hand, average_cost
       FROM commerce.partner_stock_levels
      WHERE environment=$1 AND unit_id=$2
        AND lower(trim(item_name))=lower(trim($3))
        AND lower(trim(COALESCE(tire_size,'')))=lower(trim(COALESCE($4::text,'')))
        AND lower(trim(COALESCE(brand,'')))=lower(trim(COALESCE($5::text,'')))
        AND lower(trim(COALESCE(supplier_name,'')))=lower(trim(COALESCE($6::text,'')))
        AND tire_condition IS NOT DISTINCT FROM $7
        AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
      FOR UPDATE`,
    [ctx.environment, ctx.unitId, item.item_name.trim(), clean(item.tire_size),
      clean(item.brand), supplierName, item.tire_condition],
  );
  return result.rows[0] ?? null;
}

async function incrementStock(
  client: PoolClient,
  ctx: PartnerContext,
  row: StockRow,
  item: PurchaseReceiptItem,
  receivedQuantity: number,
  actor: string,
): Promise<PurchaseReceiptMove> {
  const previousQuantity = Number(row.quantity_on_hand ?? 0);
  const previousCost = Number(row.average_cost ?? 0);
  const unitCost = Number(item.unit_cost);
  const nextQuantity = previousQuantity + receivedQuantity;
  const nextCost = nextQuantity > 0
    ? ((previousCost * previousQuantity) + (unitCost * receivedQuantity)) / nextQuantity
    : unitCost;
  const updated = await client.query<{ stock_id: string; new_qty: number; new_status: string }>(
    `UPDATE commerce.partner_stock_levels
        SET quantity_on_hand=COALESCE(quantity_on_hand,0)+$4,
            average_cost=$5,
            sale_price=COALESCE($6,sale_price),
            product_id=COALESCE(product_id,$7),
            is_tracked=true,
            stock_status=commerce.partner_stock_status(
              COALESCE(quantity_on_hand,0)+$4, quantity_reserved, minimum_quantity, true),
            updated_by=$8, updated_at=now()
      WHERE id=$1 AND environment=$2 AND unit_id=$3
      RETURNING id AS stock_id, quantity_on_hand AS new_qty, stock_status AS new_status`,
    [row.stock_id, ctx.environment, ctx.unitId, receivedQuantity, nextCost,
      item.sale_price, item.product_id, actor],
  );
  return { ...updated.rows[0]!, item_id: item.id, received_quantity: receivedQuantity };
}

export async function applyPurchaseReceiptStock(
  client: PoolClient,
  ctx: PartnerContext,
  item: PurchaseReceiptItem,
  receivedQuantity: number,
  supplierName: string | null,
  actor: string,
): Promise<PurchaseReceiptMove | null> {
  if (receivedQuantity === 0) return null;
  const normalizedSupplier = clean(supplierName);
  const lockKey = [ctx.environment, ctx.unitId, item.item_name, item.tire_size,
    item.brand, normalizedSupplier, item.tire_condition].join('|').toLowerCase();
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);

  const existing = await findStock(client, ctx, item, normalizedSupplier);
  if (existing) return incrementStock(client, ctx, existing, item, receivedQuantity, actor);

  const inserted = await client.query<{ stock_id: string; new_qty: number; new_status: string }>(
    `INSERT INTO commerce.partner_stock_levels (
       environment, unit_id, product_id, item_name, tire_size,
       tire_width_mm, tire_aspect_ratio, tire_rim_diameter, brand, supplier_name,
       quantity_on_hand, average_cost, sale_price, tire_condition,
       is_tracked, stock_status, updated_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
       true,commerce.partner_stock_status($11,0,NULL,true),$15
     ) ON CONFLICT DO NOTHING
     RETURNING id AS stock_id, quantity_on_hand AS new_qty, stock_status AS new_status`,
    [ctx.environment, ctx.unitId, item.product_id, item.item_name.trim(), clean(item.tire_size),
      item.tire_width_mm, item.tire_aspect_ratio, item.tire_rim_diameter, clean(item.brand),
      normalizedSupplier, receivedQuantity, Number(item.unit_cost), item.sale_price,
      item.tire_condition, actor],
  );
  if (inserted.rows[0]) {
    return { ...inserted.rows[0], item_id: item.id, received_quantity: receivedQuantity };
  }

  const raced = await findStock(client, ctx, item, normalizedSupplier);
  if (!raced) throw new Error('purchase_receipt_stock_conflict');
  return incrementStock(client, ctx, raced, item, receivedQuantity, actor);
}
