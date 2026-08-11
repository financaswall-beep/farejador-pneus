import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import type { PartnerContext } from './auth.js';

export interface RegistrationApprovalInput {
  average_cost: number;
  sale_price: number;
  quantity_on_hand?: number | null;
  minimum_quantity?: number | null;
  supplier_name?: string | null;
}

export class OperationStockReviewError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

type RegistrationRow = {
  id: string;
  item_type: 'pneu' | 'insumo' | 'servico';
  local_sku: string | null;
  item_name: string;
  tire_size: string | null;
  tire_width_mm: number | null;
  tire_aspect_ratio: number | null;
  tire_rim_diameter: number | null;
  brand: string | null;
  minimum_quantity: number | null;
  tire_condition: string | null;
  shelf_location: string | null;
  tire_position: string | null;
  status: string;
};

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

async function audit(
  client: PoolClient,
  ctx: PartnerContext,
  entityTable: string,
  entityId: string,
  eventType: string,
  actor: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit.events (
       environment, domain, entity_table, entity_id, event_type,
       actor_label, payload_after
     ) VALUES ($1, 'stock', $2, $3, $4, $5, $6::jsonb)`,
    [ctx.environment, entityTable, entityId, eventType, actor, JSON.stringify(payload)],
  );
}

export async function getPendingOperationStockRequests(ctx: PartnerContext) {
  const [registrations, counts] = await Promise.all([
    pool.query(
      `SELECT r.id, r.item_type, r.local_sku, r.item_name, r.tire_size,
              r.tire_width_mm, r.tire_aspect_ratio, r.tire_rim_diameter,
              r.brand, r.minimum_quantity, r.tire_condition, r.shelf_location,
              r.tire_position, r.target_stock_id, r.stock_metadata_snapshot,
              r.requested_by_label, r.created_at,
              s.local_sku AS current_local_sku, s.item_name AS current_item_name,
              s.tire_size AS current_tire_size, s.brand AS current_brand,
              s.minimum_quantity AS current_minimum_quantity,
              s.tire_condition AS current_tire_condition,
              s.shelf_location AS current_shelf_location,
              s.tire_position AS current_tire_position,
              CASE WHEN r.target_stock_id IS NULL THEN false ELSE
                s.id IS NULL OR r.stock_metadata_snapshot IS DISTINCT FROM jsonb_build_object(
                  'local_sku',s.local_sku,'item_name',s.item_name,'item_type',s.item_type,
                  'tire_size',s.tire_size,'tire_width_mm',s.tire_width_mm,
                  'tire_aspect_ratio',s.tire_aspect_ratio,'tire_rim_diameter',s.tire_rim_diameter,
                  'brand',s.brand,'minimum_quantity',s.minimum_quantity,
                  'tire_condition',s.tire_condition,'shelf_location',s.shelf_location,
                  'tire_position',s.tire_position
                ) END AS is_stale
         FROM commerce.partner_item_registration_requests r
         LEFT JOIN commerce.partner_stock_levels s ON s.id=r.target_stock_id
          AND s.environment=r.environment AND s.unit_id=r.unit_id AND s.deleted_at IS NULL
        WHERE r.environment=$1 AND r.unit_id=$2 AND r.status='pending'
        ORDER BY r.created_at ASC`,
      [ctx.environment, ctx.unitId],
    ),
    pool.query(
      `SELECT r.id, r.stock_id, r.quantity_snapshot, r.counted_quantity,
              r.reason, r.reason_detail, r.batch_id,
              r.requested_by_label, r.created_at,
              s.item_name, s.item_type, s.tire_size, s.brand,
              s.quantity_reserved,
              EXISTS (
                SELECT 1 FROM commerce.partner_stock_count_evidence e
                 WHERE e.request_id=r.id AND e.environment=r.environment AND e.unit_id=r.unit_id
              ) AS has_evidence,
              (s.quantity_on_hand IS DISTINCT FROM r.quantity_snapshot
               OR s.updated_at IS DISTINCT FROM r.stock_updated_at_snapshot) AS is_stale
         FROM commerce.partner_stock_count_requests r
         JOIN commerce.partner_stock_levels s
           ON s.id=r.stock_id AND s.environment=r.environment AND s.unit_id=r.unit_id
        WHERE r.environment=$1 AND r.unit_id=$2 AND r.status='pending'
        ORDER BY r.created_at ASC`,
      [ctx.environment, ctx.unitId],
    ),
  ]);
  const creations = registrations.rows.filter((row) => !row.target_stock_id);
  const updates = registrations.rows.filter((row) => Boolean(row.target_stock_id));
  return {
    registrations: creations,
    updates,
    counts: counts.rows,
    pending_total: creations.length + updates.length + counts.rows.length,
  };
}

export async function approveOperationRegistration(
  ctx: PartnerContext,
  actor: string,
  requestId: string,
  input: RegistrationApprovalInput,
) {
  try {
    return await inTransaction(async (client) => {
      const selected = await client.query<RegistrationRow>(
        `SELECT id, item_type, local_sku, item_name, tire_size, tire_width_mm,
                tire_aspect_ratio, tire_rim_diameter, brand, minimum_quantity,
                tire_condition, shelf_location, tire_position, status
           FROM commerce.partner_item_registration_requests
          WHERE id=$1 AND environment=$2 AND unit_id=$3 AND target_stock_id IS NULL
          FOR UPDATE`,
        [requestId, ctx.environment, ctx.unitId],
      );
      const row = selected.rows[0];
      if (!row) throw new OperationStockReviewError('stock_request_not_found', 404);
      if (row.status !== 'pending') throw new OperationStockReviewError('stock_request_already_reviewed', 409);

      const tracked = row.item_type !== 'servico';
      if (tracked && input.quantity_on_hand == null) {
        throw new OperationStockReviewError('quantity_required_for_stock_item', 400);
      }
      const quantity = tracked ? input.quantity_on_hand! : null;
      const minimum = tracked ? (input.minimum_quantity ?? row.minimum_quantity) : null;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO commerce.partner_stock_levels (
           environment, unit_id, product_id, local_sku, item_name, item_type,
           tire_size, tire_width_mm, tire_aspect_ratio, tire_rim_diameter,
           brand, supplier_name, quantity_on_hand, minimum_quantity,
           average_cost, sale_price, tire_condition, shelf_location,
           tire_position, is_tracked, stock_status, updated_by
         ) VALUES (
           $1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
           $16,$17,$18,$19,commerce.partner_stock_status($12,0,$13,$19),$20
         ) RETURNING id`,
        [ctx.environment, ctx.unitId, row.local_sku, row.item_name, row.item_type,
          row.tire_size, row.tire_width_mm, row.tire_aspect_ratio,
          row.tire_rim_diameter, row.brand, clean(input.supplier_name), quantity,
          minimum, input.average_cost, input.sale_price, row.tire_condition,
          row.shelf_location, row.tire_position, tracked, actor],
      );
      const stockId = inserted.rows[0]!.id;
      await client.query(
        `UPDATE commerce.partner_item_registration_requests
            SET status='approved', reviewed_by=$4, reviewed_at=now(),
                review_reason=NULL, approved_stock_id=$5
          WHERE id=$1 AND environment=$2 AND unit_id=$3`,
        [requestId, ctx.environment, ctx.unitId, actor, stockId],
      );
      await audit(client, ctx, 'commerce.partner_item_registration_requests', requestId,
        'partner_item_registration_approved', actor, {
          request_id: requestId, stock_id: stockId, item_name: row.item_name,
          item_type: row.item_type, quantity_on_hand: quantity,
          average_cost: input.average_cost, sale_price: input.sale_price,
        });
      return { id: requestId, stock_id: stockId, status: 'approved' as const };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new OperationStockReviewError('stock_registration_conflict', 409);
    }
    throw error;
  }
}

export async function approveOperationStockCount(
  ctx: PartnerContext,
  actor: string,
  requestId: string,
) {
  return inTransaction(async (client) => {
    const selected = await client.query<{
      status: string; stock_id: string; item_name: string;
      quantity_snapshot: number | null; counted_quantity: number;
      current_quantity: number | null; quantity_reserved: number; is_stale: boolean;
    }>(
      `SELECT r.status, r.stock_id, r.quantity_snapshot, r.counted_quantity,
              s.item_name, s.quantity_on_hand AS current_quantity,
              s.quantity_reserved,
              (s.quantity_on_hand IS DISTINCT FROM r.quantity_snapshot
               OR s.updated_at IS DISTINCT FROM r.stock_updated_at_snapshot) AS is_stale
         FROM commerce.partner_stock_count_requests r
         JOIN commerce.partner_stock_levels s
           ON s.id=r.stock_id AND s.environment=r.environment AND s.unit_id=r.unit_id
        WHERE r.id=$1 AND r.environment=$2 AND r.unit_id=$3
        FOR UPDATE OF r, s`,
      [requestId, ctx.environment, ctx.unitId],
    );
    const row = selected.rows[0];
    if (!row) throw new OperationStockReviewError('stock_request_not_found', 404);
    if (row.status !== 'pending') throw new OperationStockReviewError('stock_request_already_reviewed', 409);
    if (row.is_stale) {
      throw new OperationStockReviewError('stock_count_stale', 409, {
        snapshot: row.quantity_snapshot, current: row.current_quantity,
      });
    }
    if (row.counted_quantity < row.quantity_reserved) {
      throw new OperationStockReviewError('stock_count_below_reserved', 409, {
        counted: row.counted_quantity, reserved: row.quantity_reserved,
      });
    }
    await client.query(
      `UPDATE commerce.partner_stock_levels
          SET quantity_on_hand=$4,
              stock_status=commerce.partner_stock_status($4,quantity_reserved,minimum_quantity,is_tracked),
              updated_by=$5, updated_at=now()
        WHERE id=$1 AND environment=$2 AND unit_id=$3`,
      [row.stock_id, ctx.environment, ctx.unitId, row.counted_quantity, actor],
    );
    await client.query(
      `UPDATE commerce.partner_stock_count_requests
          SET status='approved', reviewed_by=$4, reviewed_at=now(), review_reason=NULL
        WHERE id=$1 AND environment=$2 AND unit_id=$3`,
      [requestId, ctx.environment, ctx.unitId, actor],
    );
    await audit(client, ctx, 'commerce.partner_stock_count_requests', requestId,
      'partner_stock_count_approved', actor, {
        request_id: requestId, stock_id: row.stock_id, item_name: row.item_name,
        quantity_before: row.current_quantity, quantity_after: row.counted_quantity,
      });
    return { id: requestId, stock_id: row.stock_id, status: 'approved' as const };
  });
}

export async function rejectOperationStockRequest(
  ctx: PartnerContext,
  actor: string,
  kind: 'cadastro' | 'contagem',
  requestId: string,
  reason: string,
) {
  const table = kind === 'cadastro'
    ? 'commerce.partner_item_registration_requests'
    : 'commerce.partner_stock_count_requests';
  return inTransaction(async (client) => {
    const rejected = await client.query<{ id: string }>(
      `UPDATE ${table}
          SET status='rejected', reviewed_by=$4, reviewed_at=now(), review_reason=$5
        WHERE id=$1 AND environment=$2 AND unit_id=$3 AND status='pending'
        RETURNING id`,
      [requestId, ctx.environment, ctx.unitId, actor, reason.trim()],
    );
    if (!rejected.rows[0]) throw new OperationStockReviewError('stock_request_not_pending', 409);
    const eventType = kind === 'cadastro'
      ? 'partner_item_registration_rejected'
      : 'partner_stock_count_rejected';
    await audit(client, ctx, table, requestId, eventType, actor, {
      request_id: requestId, reason: reason.trim(),
    });
    return { id: requestId, status: 'rejected' as const };
  });
}
