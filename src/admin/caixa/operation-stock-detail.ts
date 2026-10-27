import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMatrizOperationStock, MatrizOperationStockPriceError } from './operation-stock.js';
import { stockMovementSource } from '../painel/stock-report-rules.js';

export async function getMatrizOperationStockItem(stockId: string, db: Pool = pool) {
  const { rows } = await getMatrizOperationStock(db);
  const stock = rows.find(row => row.stock_id === stockId);
  if (!stock) throw new MatrizOperationStockPriceError('stock_not_found', 404);
  return stock;
}

const reservationEvents = `
  SELECT DISTINCT ON (a.entity_id) a.entity_id,a.payload_after,a.created_at,a.id
    FROM audit.events a
    JOIN commerce.orders o ON o.environment=a.environment AND o.id=a.entity_id
    JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
   WHERE a.environment=$1 AND o.partner_order_id IS NULL
     AND o.status<>'cancelled'
     AND a.event_type IN ('matriz_galpao_reserved','matriz_galpao_reservation_adjusted')
     AND NOT EXISTS (SELECT 1 FROM audit.events terminal
       WHERE terminal.environment=a.environment AND terminal.entity_id=a.entity_id
         AND terminal.event_type IN ('matriz_galpao_decrement','matriz_galpao_reservation_released'))
   ORDER BY a.entity_id,a.created_at DESC,a.id DESC`;

export async function getMatrizStockReservations(stockId: string, page: number, db: Pool = pool) {
  const stock = await getMatrizOperationStockItem(stockId, db);
  const result = await db.query<{
    order_id: string; order_number: string | null; customer_name: string | null;
    fulfillment_mode: string; quantity: string; created_at: string;
  }>(`WITH active AS (${reservationEvents})
    SELECT o.id order_id,o.order_number,pr.contact_name customer_name,o.fulfillment_mode,
           sum((m->>'qty')::int)::text quantity,active.created_at
      FROM active
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(active.payload_after->'movements','[]'::jsonb)) m
      JOIN commerce.orders o ON o.environment=$1 AND o.id=active.entity_id
      LEFT JOIN dashboard.pedidos_recentes pr ON pr.environment=o.environment AND pr.order_id=o.id
     WHERE m->>'measure'=$2 AND m->>'brand'=$3 AND m->>'tire_condition'=$4
       AND (m->>'qty')::int>0
     GROUP BY o.id,o.order_number,pr.contact_name,o.fulfillment_mode,active.created_at
     ORDER BY active.created_at DESC,o.id DESC LIMIT 21 OFFSET $5`,
  [env.FAREJADOR_ENV, stock.tire_size, stock.brand, stock.tire_condition, (page - 1) * 20]);
  return { stock, reservations: { rows: result.rows.slice(0, 20).map(row => ({
    order_id: row.order_id, order_number: row.order_number, customer_name: row.customer_name,
    fulfillment_mode: row.fulfillment_mode, quantity: Number(row.quantity), created_at: row.created_at,
  })), page, has_more: result.rows.length > 20 } };
}

/** O filme físico vem do trigger; reservas são identificadas separadamente na auditoria.
 * Ajustes de reserva mostram o delta, nunca uma saída física nem o total como nova reserva. */
export async function getMatrizStockHistory(
  stockId: string, page: number, days: 30 | 90 | null, db: Pool = pool,
) {
  const stock = await getMatrizOperationStockItem(stockId, db);
  const result = await db.query<{
    id: string; occurred_at: string; kind: string; source: string;
    quantity_delta: number; ref: string | null; order_number: string | null;
  }>(`WITH physical AS (
    SELECT m.id::text,m.created_at occurred_at,'physical'::text kind,m.source,m.qty_delta quantity_delta,
           m.ref,o.order_number
      FROM commerce.wholesale_stock_movements m
      LEFT JOIN commerce.orders o ON o.environment=m.environment AND o.id::text=m.ref
     WHERE m.environment=$1 AND m.measure=$2 AND m.brand=$3 AND m.tire_condition=$4
       AND m.qty_delta<>0 AND ($5::int IS NULL OR m.created_at>=now()-make_interval(days=>$5::int))
  ), reservations AS (
    SELECT a.id::text,a.created_at occurred_at,'reservation'::text kind,a.event_type source,
           CASE WHEN a.event_type='matriz_galpao_reserved' THEN COALESCE(after_qty.qty,0)
                WHEN a.event_type IN ('matriz_galpao_reservation_released','matriz_galpao_decrement') THEN -COALESCE(after_qty.qty,0)
                ELSE COALESCE(after_qty.qty,0)-COALESCE(before_qty.qty,0) END::int quantity_delta,
           o.id::text ref,o.order_number
      FROM audit.events a
      JOIN commerce.orders o ON o.environment=a.environment AND o.id=a.entity_id AND o.partner_order_id IS NULL
      JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
      LEFT JOIN LATERAL (
        SELECT sum((m->>'qty')::int) qty
          FROM jsonb_array_elements(COALESCE(a.payload_after->'movements','[]'::jsonb)) m
         WHERE m->>'measure'=$2 AND m->>'brand'=$3 AND m->>'tire_condition'=$4
      ) after_qty ON true
      LEFT JOIN LATERAL (
        SELECT sum((m->>'qty')::int) qty
          FROM jsonb_array_elements(COALESCE(a.payload_before->'movements','[]'::jsonb)) m
         WHERE m->>'measure'=$2 AND m->>'brand'=$3 AND m->>'tire_condition'=$4
      ) before_qty ON true
     WHERE a.environment=$1
       AND a.event_type IN ('matriz_galpao_reserved','matriz_galpao_reservation_adjusted','matriz_galpao_reservation_released','matriz_galpao_decrement')
       AND (a.event_type<>'matriz_galpao_decrement' OR EXISTS (
         SELECT 1 FROM audit.events reserved WHERE reserved.environment=a.environment
           AND reserved.entity_id=a.entity_id AND reserved.event_type='matriz_galpao_reserved'))
       AND ($5::int IS NULL OR a.created_at>=now()-make_interval(days=>$5::int))
  ), movements AS (SELECT * FROM physical UNION ALL SELECT * FROM reservations WHERE quantity_delta<>0)
    SELECT id,occurred_at,kind,source,quantity_delta,ref,order_number FROM movements
     ORDER BY occurred_at DESC,id DESC LIMIT 21 OFFSET $6`,
  [env.FAREJADOR_ENV, stock.tire_size, stock.brand, stock.tire_condition, days, (page - 1) * 20]);
  return { stock, history: { rows: result.rows.slice(0, 20).map(row => ({
    id: row.id, occurred_at: row.occurred_at, kind: row.kind, source: row.source,
    quantity_delta: Number(row.quantity_delta), ref: row.ref, order_number: row.order_number,
    label: row.kind === 'physical' ? stockMovementSource(row.source).label : null,
  })), page, has_more: result.rows.length > 20 } };
}
