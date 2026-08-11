import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';
import { OperationStockReviewError } from './operation-stock-owner.js';
import type { OperationItemType, TireCondition } from './operation-stock.js';

export interface OperationStockUpdateInput {
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

type StockMetadata = {
  local_sku: string | null; item_name: string; item_type: OperationItemType;
  tire_size: string | null; tire_width_mm: number | null;
  tire_aspect_ratio: number | null; tire_rim_diameter: number | null;
  brand: string | null; minimum_quantity: number | null;
  tire_condition: TireCondition | null; shelf_location: string | null;
  tire_position: string | null;
};

type RequestResult = { id: string; status: 'pending'; created_at: string };

export class OperationStockUpdateError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function proposedMetadata(current: StockMetadata, input: OperationStockUpdateInput): StockMetadata {
  const tire = current.item_type === 'pneu';
  const service = current.item_type === 'servico';
  if (tire && (
    input.tire_width_mm == null || input.tire_aspect_ratio == null
    || input.tire_rim_diameter == null || input.tire_condition == null
  )) throw new OperationStockUpdateError('tire_fields_required', 400);
  if (service && [
    input.tire_width_mm, input.tire_aspect_ratio, input.tire_rim_diameter,
    input.tire_condition, input.minimum_quantity, input.shelf_location, input.tire_position,
  ].some((value) => value != null)) {
    throw new OperationStockUpdateError('service_has_no_stock_fields', 400);
  }
  const tireSize = tire
    ? `${input.tire_width_mm}/${input.tire_aspect_ratio}-${input.tire_rim_diameter}`
    : null;
  return {
    local_sku: clean(input.local_sku), item_name: input.item_name.trim(),
    item_type: current.item_type, tire_size: tireSize,
    tire_width_mm: tire ? input.tire_width_mm! : null,
    tire_aspect_ratio: tire ? input.tire_aspect_ratio! : null,
    tire_rim_diameter: tire ? input.tire_rim_diameter! : null,
    brand: service ? null : clean(input.brand),
    minimum_quantity: service ? null : (input.minimum_quantity ?? null),
    tire_condition: tire ? input.tire_condition! : null,
    shelf_location: service ? null : clean(input.shelf_location),
    tire_position: tire ? clean(input.tire_position) : null,
  };
}

export async function requestOperationStockUpdate(
  ctx: PartnerContext,
  actor: string,
  stockId: string,
  input: OperationStockUpdateInput,
): Promise<RequestResult> {
  try {
    return await withPartnerContext(ctx.partnerUnitId, async (client) => {
      const selected = await client.query<StockMetadata>(
        `SELECT local_sku,item_name,item_type,tire_size,tire_width_mm,
                tire_aspect_ratio,tire_rim_diameter,brand,minimum_quantity,
                tire_condition,shelf_location,tire_position
           FROM commerce.partner_stock_levels
          WHERE id=$1 AND environment=$2 AND unit_id=$3 AND deleted_at IS NULL`,
        [stockId, ctx.environment, ctx.unitId],
      );
      const current = selected.rows[0];
      if (!current) throw new OperationStockUpdateError('stock_not_found', 404);
      const proposed = proposedMetadata(current, input);
      const values = [
        ctx.environment, ctx.unitId, ctx.tokenId, actor, proposed.item_type,
        proposed.local_sku, proposed.item_name, proposed.tire_size,
        proposed.tire_width_mm, proposed.tire_aspect_ratio, proposed.tire_rim_diameter,
        proposed.brand, proposed.minimum_quantity, proposed.tire_condition,
        proposed.shelf_location, proposed.tire_position, input.idempotency_key,
        stockId, JSON.stringify(current),
      ];
      const inserted = await client.query<RequestResult>(
        `INSERT INTO commerce.partner_item_registration_requests (
           environment,unit_id,requested_by_token_id,requested_by_label,item_type,
           local_sku,item_name,tire_size,tire_width_mm,tire_aspect_ratio,
           tire_rim_diameter,brand,minimum_quantity,tire_condition,shelf_location,
           tire_position,idempotency_key,target_stock_id,stock_metadata_snapshot
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb
         ) ON CONFLICT (environment,unit_id,idempotency_key) DO NOTHING
         RETURNING id,status,created_at`,
        values,
      );
      if (inserted.rows[0]) return inserted.rows[0];
      const existing = await client.query<RequestResult>(
        `SELECT id,status,created_at
           FROM commerce.partner_item_registration_requests
          WHERE environment=$1 AND unit_id=$2 AND idempotency_key=$3`,
        [ctx.environment, ctx.unitId, input.idempotency_key],
      );
      return existing.rows[0]!;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new OperationStockUpdateError('stock_update_already_pending', 409);
    }
    throw error;
  }
}

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
  } finally { client.release(); }
}

export async function approveOperationStockUpdate(
  ctx: PartnerContext,
  actor: string,
  requestId: string,
) {
  try {
    return await inTransaction(async (client) => {
      const selected = await client.query<StockMetadata & {
        id: string; status: string; target_stock_id: string; is_stale: boolean;
        metadata_before: StockMetadata;
      }>(
        `SELECT r.id,r.status,r.target_stock_id,r.local_sku,r.item_name,r.item_type,
                r.tire_size,r.tire_width_mm,r.tire_aspect_ratio,r.tire_rim_diameter,
                r.brand,r.minimum_quantity,r.tire_condition,r.shelf_location,r.tire_position,
                r.stock_metadata_snapshot AS metadata_before,
                r.stock_metadata_snapshot IS DISTINCT FROM jsonb_build_object(
                  'local_sku',s.local_sku,'item_name',s.item_name,'item_type',s.item_type,
                  'tire_size',s.tire_size,'tire_width_mm',s.tire_width_mm,
                  'tire_aspect_ratio',s.tire_aspect_ratio,'tire_rim_diameter',s.tire_rim_diameter,
                  'brand',s.brand,'minimum_quantity',s.minimum_quantity,
                  'tire_condition',s.tire_condition,'shelf_location',s.shelf_location,
                  'tire_position',s.tire_position
                ) AS is_stale
           FROM commerce.partner_item_registration_requests r
           JOIN commerce.partner_stock_levels s ON s.id=r.target_stock_id
             AND s.environment=r.environment AND s.unit_id=r.unit_id AND s.deleted_at IS NULL
          WHERE r.id=$1 AND r.environment=$2 AND r.unit_id=$3
          FOR UPDATE OF r,s`,
        [requestId, ctx.environment, ctx.unitId],
      );
      const row = selected.rows[0];
      if (!row?.target_stock_id) throw new OperationStockReviewError('stock_request_not_found', 404);
      if (row.status !== 'pending') throw new OperationStockReviewError('stock_request_already_reviewed', 409);
      if (row.is_stale) throw new OperationStockReviewError('stock_update_stale', 409);
      await client.query(
        `UPDATE commerce.partner_stock_levels SET
           local_sku=$4,item_name=$5,tire_size=$6,tire_width_mm=$7,
           tire_aspect_ratio=$8,tire_rim_diameter=$9,brand=$10,minimum_quantity=$11,
           tire_condition=$12,shelf_location=$13,tire_position=$14,
           stock_status=commerce.partner_stock_status(
             quantity_on_hand,quantity_reserved,$11,is_tracked),updated_by=$15,updated_at=now()
         WHERE id=$1 AND environment=$2 AND unit_id=$3`,
        [row.target_stock_id, ctx.environment, ctx.unitId, row.local_sku, row.item_name,
          row.tire_size, row.tire_width_mm, row.tire_aspect_ratio, row.tire_rim_diameter,
          row.brand, row.minimum_quantity, row.tire_condition, row.shelf_location,
          row.tire_position, actor],
      );
      await client.query(
        `UPDATE commerce.partner_item_registration_requests
            SET status='approved',reviewed_by=$4,reviewed_at=now(),review_reason=NULL,
                approved_stock_id=$5
          WHERE id=$1 AND environment=$2 AND unit_id=$3`,
        [requestId, ctx.environment, ctx.unitId, actor, row.target_stock_id],
      );
      const after: StockMetadata = {
        local_sku: row.local_sku, item_name: row.item_name, item_type: row.item_type,
        tire_size: row.tire_size, tire_width_mm: row.tire_width_mm,
        tire_aspect_ratio: row.tire_aspect_ratio, tire_rim_diameter: row.tire_rim_diameter,
        brand: row.brand, minimum_quantity: row.minimum_quantity,
        tire_condition: row.tire_condition, shelf_location: row.shelf_location,
        tire_position: row.tire_position,
      };
      await client.query(
        `INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,
          actor_label,payload_before,payload_after)
         VALUES ($1,'stock','commerce.partner_stock_levels',$2,
          'partner_stock_update_approved',$3,$4::jsonb,$5::jsonb)`,
        [ctx.environment, row.target_stock_id, actor,
          JSON.stringify(row.metadata_before), JSON.stringify({ ...after, request_id: requestId, stock_id: row.target_stock_id })],
      );
      return { id: requestId, stock_id: row.target_stock_id, status: 'approved' as const };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new OperationStockReviewError('stock_update_conflict', 409);
    }
    throw error;
  }
}
