import type { Pool, PoolClient } from 'pg';
import { pool } from '../../persistence/db.js';
export type RequestEnvironment = 'prod' | 'test';
export interface WholesaleRequest {
  id: string; environment: RequestEnvironment; partner_unit_id: string;
  partner_id: string; unit_id: string; status: string; wholesale_order_id: string | null;
  receipt_key: string | null; receipt_items: unknown; receipt_result: Record<string, unknown> | null;
  rejection_reason: string | null;
}
export interface WholesaleRequestItem {
  id: string; product_id: string; measure: string; brand: string; tire_condition: string;
  catalog_measure: string; catalog_brand: string | null;
  vehicle_type: string; quantity: number; unit_price_cents: string;
  wholesale_order_item_id: string | null;
}
export async function requestTransaction<T>(fn: (client: PoolClient) => Promise<T>, dbPool: Pool = pool): Promise<T> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
export async function lockRequest(client: PoolClient, environment: RequestEnvironment, id: string, unitId?: string, requireActive = true) {
  const result = await client.query<WholesaleRequest>(
    `SELECT r.*,u.partner_id,u.unit_id FROM commerce.partner_wholesale_requests r
     JOIN network.partner_units u ON u.id=r.partner_unit_id AND u.environment=r.environment
     JOIN network.partners p ON p.id=u.partner_id AND p.environment=u.environment
     WHERE r.id=$1 AND r.environment=$2 AND ($3::uuid IS NULL OR u.id=$3)
       AND (NOT $4 OR (u.status='active' AND p.status='active' AND u.deleted_at IS NULL AND p.deleted_at IS NULL))
       FOR UPDATE OF r`, [id,environment,unitId ?? null,requireActive]);
  if (!result.rows[0]) throw new Error('request_not_found');
  return result.rows[0];
}
export async function requestItems(client: PoolClient, environment: RequestEnvironment, id: string) {
  const items=(await client.query<WholesaleRequestItem>(
    `SELECT * FROM commerce.partner_wholesale_request_items WHERE request_id=$1 AND environment=$2
     ORDER BY measure,brand,tire_condition,id`, [id,environment])).rows;
  return items.sort((a,b)=>`${a.measure}\u0000${a.brand}\u0000${a.tire_condition}`.localeCompare(`${b.measure}\u0000${b.brand}\u0000${b.tire_condition}`));
}
export async function changeRequestReservation(client: PoolClient, request: WholesaleRequest,
  items: WholesaleRequestItem[], direction: 1 | -1) {
  for (const item of items) {
    const result = await client.query(
      `UPDATE commerce.wholesale_stock SET quantity_reserved=quantity_reserved+$5
       WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4
         AND quantity_reserved+$5>=0 AND quantity_on_hand>=quantity_reserved+$5`,
      [request.environment,item.measure,item.brand,item.tire_condition,direction*item.quantity]);
    if (result.rowCount !== 1) throw new Error(direction===1 ? 'stock_changed' : 'reservation_conflict');
  }
}
export async function listWholesaleRequests(environment: RequestEnvironment, dbPool: Pool = pool) {
  const result = await dbPool.query(
    `SELECT r.id,'CMP-'||r.request_number AS request_number,r.status,r.total_cents,r.created_at,
       r.rejection_reason,r.wholesale_order_id,u.display_name AS partner_name,
       o.payment_status,o.partner_transfer_status,o.due_date,p.receipt_status,(o.settled_total_amount*100)::bigint AS settled_total_cents,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('item_id',i.id,'measure',i.catalog_measure,'brand',i.catalog_brand,
         'tire_condition',i.tire_condition,'quantity',i.quantity,'unit_price_cents',i.unit_price_cents)
         ORDER BY i.measure,i.brand) FROM commerce.partner_wholesale_request_items i
         WHERE i.request_id=r.id AND i.environment=r.environment),'[]') AS items
     FROM commerce.partner_wholesale_requests r
     JOIN network.partner_units u ON u.id=r.partner_unit_id AND u.environment=r.environment
     LEFT JOIN commerce.wholesale_orders o ON o.id=r.wholesale_order_id AND o.environment=r.environment
     LEFT JOIN commerce.partner_purchases p ON p.source_wholesale_order_id=o.id AND p.environment=o.environment AND p.deleted_at IS NULL
     WHERE r.environment=$1 ORDER BY (r.status IN ('requested','approved')) DESC,r.created_at DESC,r.id LIMIT 100`, [environment]);
  return { rows: result.rows };
}
