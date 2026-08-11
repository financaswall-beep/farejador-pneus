import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';

export type OperationItemType = 'pneu' | 'insumo' | 'servico';
export type TireCondition = 'meia_vida' | 'novo' | 'remold';

export interface OperationItemRegistrationInput {
  item_type: OperationItemType;
  local_sku?: string | null;
  item_name: string;
  tire_width_mm?: number | null;
  tire_aspect_ratio?: number | null;
  tire_rim_diameter?: number | null;
  brand?: string | null;
  minimum_quantity?: number | null;
  tire_condition?: TireCondition | null;
  shelf_location?: string | null;
  tire_position?: string | null;
  idempotency_key: string;
}

export interface SafeStockRow {
  stock_id: string;
  local_sku: string | null;
  item_name: string;
  item_type: OperationItemType;
  tire_size: string | null;
  tire_width_mm: number | null;
  tire_aspect_ratio: number | null;
  tire_rim_diameter: number | null;
  brand: string | null;
  quantity_on_hand: number | null;
  quantity_reserved: number;
  quantity_available: number | null;
  minimum_quantity: number | null;
  stock_status: string;
  tire_condition: TireCondition | null;
  shelf_location: string | null;
  tire_position: string | null;
  is_tracked: boolean;
  updated_at: string;
}

interface PendingRow {
  item_registrations: number;
  stock_counts: number;
}

interface RequestResult {
  id: string;
  status: 'pending';
  created_at: string;
}

export async function getOperationStock(ctx: PartnerContext): Promise<{
  rows: SafeStockRow[];
  pending: PendingRow;
}> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const [stock, pending] = await Promise.all([
      client.query<SafeStockRow>(
        `SELECT id AS stock_id, local_sku, item_name, item_type, tire_size,
                tire_width_mm, tire_aspect_ratio, tire_rim_diameter, brand,
                quantity_on_hand, quantity_reserved,
                CASE WHEN quantity_on_hand IS NULL THEN NULL
                     ELSE GREATEST(quantity_on_hand-quantity_reserved, 0) END AS quantity_available,
                minimum_quantity, stock_status, tire_condition, shelf_location,
                tire_position, is_tracked, updated_at
           FROM commerce.partner_stock_levels
          WHERE environment=$1 AND unit_id=$2 AND deleted_at IS NULL
          ORDER BY (item_type='servico'), item_name, brand NULLS LAST`,
        [ctx.environment, ctx.unitId],
      ),
      client.query<PendingRow>(
        `SELECT
           (SELECT count(*)::int FROM commerce.partner_item_registration_requests
             WHERE environment=$1 AND unit_id=$2 AND status='pending') AS item_registrations,
           (SELECT count(*)::int FROM commerce.partner_stock_count_requests
             WHERE environment=$1 AND unit_id=$2 AND status='pending') AS stock_counts`,
        [ctx.environment, ctx.unitId],
      ),
    ]);
    return {
      rows: stock.rows,
      pending: pending.rows[0] ?? { item_registrations: 0, stock_counts: 0 },
    };
  });
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export async function requestOperationItemRegistration(
  ctx: PartnerContext,
  actorLabel: string,
  data: OperationItemRegistrationInput,
): Promise<RequestResult> {
  const isTire = data.item_type === 'pneu';
  const isService = data.item_type === 'servico';
  const tireSize = isTire
    ? `${data.tire_width_mm}/${data.tire_aspect_ratio}-${data.tire_rim_diameter}`
    : null;

  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const values = [
      ctx.environment, ctx.unitId, ctx.tokenId, actorLabel, data.item_type,
      clean(data.local_sku), data.item_name.trim(), tireSize,
      isTire ? data.tire_width_mm : null,
      isTire ? data.tire_aspect_ratio : null,
      isTire ? data.tire_rim_diameter : null,
      clean(data.brand), isService ? null : (data.minimum_quantity ?? null),
      isTire ? (data.tire_condition ?? null) : null,
      isService ? null : clean(data.shelf_location),
      isTire ? clean(data.tire_position) : null,
      data.idempotency_key,
    ];
    const inserted = await client.query<RequestResult>(
      `INSERT INTO commerce.partner_item_registration_requests (
         environment, unit_id, requested_by_token_id, requested_by_label,
         item_type, local_sku, item_name, tire_size, tire_width_mm,
         tire_aspect_ratio, tire_rim_diameter, brand, minimum_quantity,
         tire_condition, shelf_location, tire_position, idempotency_key
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
       ) ON CONFLICT (environment, unit_id, idempotency_key) DO NOTHING
       RETURNING id, status, created_at`,
      values,
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await client.query<RequestResult>(
      `SELECT id, status, created_at
         FROM commerce.partner_item_registration_requests
        WHERE environment=$1 AND unit_id=$2 AND idempotency_key=$3`,
      [ctx.environment, ctx.unitId, data.idempotency_key],
    );
    return existing.rows[0]!;
  });
}

export {
  requestOperationStockCount,
  StockUnavailableForCountError,
} from './operation-stock-count.js';
export type { OperationStockCountInput } from './operation-stock-count.js';
