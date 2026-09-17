import type { Pool } from 'pg';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { MAIN_DELIVERY_GUARD } from './queries-logistica-read.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T12:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'data_invalida');
export const logisticsDeliveriesQuery = z.object({
  from: date, to: date,
  q: z.string().trim().max(120).default(''),
  courier: z.string().max(180).default(''),
  status: z.enum(['all', 'pending', 'dispatched', 'delivered', 'failed']).default('all'),
  sort: z.enum(['scheduled_asc', 'scheduled_desc', 'value_desc', 'customer_asc']).default('scheduled_asc'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(8),
}).strict().refine(f => f.from <= f.to && (Date.parse(f.to) - Date.parse(f.from)) / 86400000 <= 365,
  'Escolha um período de até 366 dias.');

export async function listMatrizDeliveries(
  filter: z.infer<typeof logisticsDeliveriesQuery>,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  db: Pool = pool,
) {
  const sort = {
    scheduled_asc: 'scheduled_date ASC, created_at ASC, order_id ASC',
    scheduled_desc: 'scheduled_date DESC, created_at DESC, order_id ASC',
    value_desc: 'total_amount::numeric DESC, order_id ASC',
    customer_asc: 'customer_name ASC NULLS LAST, order_id ASC',
  }[filter.sort];
  const search = filter.q.replace(/^#/, '').replace(/[\\%_]/g, '\\$&');
  // Contagens, página e responsáveis compartilham o mesmo snapshot e escopo.
  const result = await db.query(`
    WITH deliveries AS (
      SELECT o.id AS order_id, o.order_number, o.status, o.delivery_status,
        COALESCE(c.name,cu.name) AS customer_name,
        COALESCE(c.phone_e164,cu.phone_e164) AS customer_phone,
        o.delivery_address, o.total_amount::text, o.payment_method, o.created_at,
        o.dispatched_at, o.delivered_at, o.delivery_failure_reason,
        o.trip_id, t.trip_number, t.status AS trip_status,
        COALESCE(t.courier_name,o.delivery_courier) AS delivery_courier,
        CASE WHEN t.courier_collaborator_id IS NOT NULL THEN t.courier_collaborator_id::text
          WHEN COALESCE(t.courier_name,o.delivery_courier,'') <> ''
            THEN 'name:' || COALESCE(t.courier_name,o.delivery_courier)
          ELSE 'unassigned' END AS courier_key,
        CASE WHEN o.status = 'cancelled' THEN 'failed' ELSE o.delivery_status END AS situation,
        COALESCE(o.scheduled_delivery_date,
          (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date + 1)::text AS scheduled_date
      FROM commerce.orders o
      LEFT JOIN core.contacts c ON c.id=o.contact_id AND c.environment=o.environment
      LEFT JOIN commerce.customers cu ON cu.id=o.customer_id AND cu.environment=o.environment
      LEFT JOIN commerce.matriz_delivery_trips t ON t.id=o.trip_id AND t.environment=o.environment AND t.deleted_at IS NULL
      WHERE o.environment=$1 AND ${MAIN_DELIVERY_GUARD}
    ), scoped AS (
      SELECT * FROM deliveries WHERE scheduled_date BETWEEN $2 AND $3
        AND ($4='' OR concat_ws(' ',order_number,customer_name,customer_phone,delivery_address) ILIKE '%' || $4 || '%')
        AND ($5='' OR courier_key=$5)
    ), counts AS (
      SELECT count(*)::int AS all,
        count(*) FILTER (WHERE situation='pending')::int AS pending,
        count(*) FILTER (WHERE situation='dispatched')::int AS dispatched,
        count(*) FILTER (WHERE situation='delivered')::int AS delivered,
        count(*) FILTER (WHERE situation='failed')::int AS failed FROM scoped
    ), filtered AS (
      SELECT * FROM scoped WHERE $6='all' OR situation=$6
    ), totals AS (
      SELECT count(*)::int AS total,
        LEAST($7::int,GREATEST(1,ceil(count(*)::numeric/$8::int)::int)) AS page FROM filtered
    ), page_rows AS (
      SELECT * FROM filtered ORDER BY ${sort} LIMIT $8 OFFSET (SELECT (page-1)*$8 FROM totals)
    )
    SELECT (SELECT row_to_json(counts) FROM counts) AS counts,
      (SELECT total FROM totals) AS total, (SELECT page FROM totals) AS page,
      COALESCE((SELECT jsonb_agg(detail ORDER BY ${sort}) FROM (
        SELECT p.*, COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'label',COALESCE(pr.product_name,'Item'), 'quantity',oi.quantity,
          'unit_price',oi.unit_price, 'total',oi.quantity*oi.unit_price-oi.discount_amount)
          ORDER BY oi.created_at,oi.id)
          FROM commerce.order_items oi
          LEFT JOIN commerce.products pr ON pr.id=oi.product_id AND pr.environment=oi.environment
          WHERE oi.order_id=p.order_id AND oi.environment=$1),'[]'::jsonb) AS items
        FROM page_rows p) detail),'[]'::jsonb) AS rows,
      COALESCE((SELECT jsonb_agg(x ORDER BY x.name,x.id) FROM (
        SELECT courier_key AS id, max(delivery_courier) AS name FROM deliveries
        WHERE courier_key <> 'unassigned' GROUP BY courier_key) x),'[]'::jsonb) AS couriers
  `, [environment, filter.from, filter.to, search, filter.courier, filter.status, filter.page, filter.page_size]);
  return { ...result.rows[0], page_size: filter.page_size };
}
