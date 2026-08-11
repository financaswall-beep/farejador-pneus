import { pool } from '../persistence/db.js';
import type { PartnerContext } from './auth.js';

const HISTORY_EVENTS = [
  'partner_item_registration_approved',
  'partner_stock_update_approved',
  'partner_stock_count_approved',
  'stock_decrement_purchase_cancel',
  'stock_decrement_sale',
  'stock_increment_purchase',
  'stock_increment_sale_cancel',
  'stock_item_created',
  'stock_item_updated',
  'stock_reserved',
  'stock_reservation_released',
] as const;

type JsonObject = Record<string, unknown>;
type AuditEvent = {
  id: string; entity_id: string | null; event_type: string;
  actor_label: string | null; payload_after: unknown; created_at: string;
};

export type OperationStockMovement = {
  id: string;
  kind: 'purchase' | 'purchase_cancel' | 'sale' | 'sale_cancel' | 'count'
    | 'registration' | 'update' | 'reservation' | 'reservation_release';
  reference_id: string | null;
  quantity_delta: number | null;
  actor_label: string | null;
  occurred_at: string;
};

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function number(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function reference(payload: JsonObject, event: AuditEvent): string | null {
  const value = payload.order_id ?? payload.purchase_id ?? payload.request_id;
  return typeof value === 'string' ? value : event.entity_id;
}

export function normalizeOperationStockMovement(
  event: AuditEvent,
  stockId: string,
): OperationStockMovement | null {
  const payload = object(event.payload_after);
  const moves = Array.isArray(payload.moves) ? payload.moves.map(object) : [];
  const moveIndex = moves.findIndex((item) => item.stock_id === stockId);
  const move = moveIndex >= 0 ? moves[moveIndex]! : {};
  const items = Array.isArray(payload.items) ? payload.items.map(object) : [];
  const item = moveIndex >= 0 ? (items[moveIndex] ?? {}) : {};
  const quantity = number(payload.quantity ?? item.quantity);
  const directDelta = number(move.delta);
  const reservedDelta = number(move.reserved_delta);
  let kind: OperationStockMovement['kind'];
  let delta: number | null = directDelta;

  switch (event.event_type) {
    case 'stock_increment_purchase': kind = 'purchase'; delta ??= quantity; break;
    case 'stock_decrement_purchase_cancel': kind = 'purchase_cancel'; delta ??= quantity == null ? null : -quantity; break;
    case 'stock_decrement_sale': kind = 'sale'; delta ??= quantity == null ? null : -quantity; break;
    case 'stock_increment_sale_cancel': kind = 'sale_cancel'; delta ??= quantity; break;
    case 'partner_stock_count_approved': {
      kind = 'count';
      const before = number(payload.quantity_before);
      const after = number(payload.quantity_after);
      delta = before == null || after == null ? null : after - before;
      break;
    }
    case 'partner_item_registration_approved': kind = 'registration'; delta = number(payload.quantity_on_hand); break;
    case 'partner_stock_update_approved': kind = 'update'; delta = null; break;
    case 'stock_item_created': kind = 'registration'; delta = number(payload.quantity_on_hand); break;
    case 'stock_item_updated': kind = 'update'; delta = null; break;
    case 'stock_reserved': kind = 'reservation'; delta = reservedDelta == null ? null : -reservedDelta; break;
    case 'stock_reservation_released': kind = 'reservation_release'; delta = quantity; break;
    default: return null;
  }

  return {
    id: `${event.id}:${Math.max(moveIndex, 0)}`,
    kind,
    reference_id: reference(payload, event),
    quantity_delta: delta,
    actor_label: event.actor_label,
    occurred_at: event.created_at,
  };
}

const eventMatchesStock = `
  e.environment=$1 AND e.domain='stock' AND e.event_type=ANY($3::text[])
  AND (
    e.entity_id=$2::uuid OR e.payload_after->>'stock_id'=$2::text
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(e.payload_after->'moves')='array'
               THEN e.payload_after->'moves' ELSE '[]'::jsonb END
        ) AS movement
       WHERE movement->>'stock_id'=$2::text
    )
  )`;

export async function getOperationStockDetail(
  ctx: PartnerContext,
  stockId: string,
  page: number,
  limit: number,
) {
  const stock = await pool.query(
    `SELECT id AS stock_id, local_sku, item_name, item_type, tire_size,
            tire_width_mm, tire_aspect_ratio, tire_rim_diameter, brand,
            quantity_on_hand, quantity_reserved,
            CASE WHEN quantity_on_hand IS NULL THEN NULL
                 ELSE GREATEST(quantity_on_hand-quantity_reserved, 0) END AS quantity_available,
            minimum_quantity, sale_price, stock_status, tire_condition,
            shelf_location, tire_position, is_tracked, updated_at,
            EXISTS (
              SELECT 1
                FROM commerce.partner_item_registration_requests request
               WHERE request.environment=partner_stock_levels.environment
                 AND request.unit_id=partner_stock_levels.unit_id
                 AND request.target_stock_id=partner_stock_levels.id
                 AND request.status='pending'
            ) AS update_pending
       FROM commerce.partner_stock_levels
      WHERE id=$1 AND environment=$2 AND unit_id=$3 AND deleted_at IS NULL`,
    [stockId, ctx.environment, ctx.unitId],
  );
  if (!stock.rows[0]) return null;

  const offset = (page - 1) * limit;
  const params = [ctx.environment, stockId, [...HISTORY_EVENTS]];
  const [events, count] = await Promise.all([
    pool.query<AuditEvent>(
      `SELECT e.id,e.entity_id,e.event_type,e.actor_label,e.payload_after,e.created_at
         FROM audit.events e WHERE ${eventMatchesStock}
        ORDER BY e.created_at DESC,e.id DESC LIMIT $4 OFFSET $5`,
      [...params, limit, offset],
    ),
    pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM audit.events e WHERE ${eventMatchesStock}`,
      params,
    ),
  ]);
  const movements = events.rows
    .map((event) => normalizeOperationStockMovement(event, stockId))
    .filter((movement): movement is OperationStockMovement => movement !== null);
  const total = count.rows[0]?.total ?? 0;
  return {
    stock: stock.rows[0],
    history: { rows: movements, page, limit, total, has_more: offset + events.rows.length < total },
  };
}
