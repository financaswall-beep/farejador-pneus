import type { Pool } from 'pg';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { tripSelect } from './queries-logistica-trip-select.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v + 'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
});
export const logisticsHistoryQuery = z.object({
  from: day, to: day, q: z.string().trim().max(120).default(''),
  courier: z.string().max(180).default(''),
  financial: z.enum(['all', 'reconciled', 'pending', 'divergent']).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
}).strict().refine(f => f.from <= f.to && (Date.parse(f.to) - Date.parse(f.from)) / 86400000 <= 365, 'invalid_period');

export async function listMatrizHistory(f: z.infer<typeof logisticsHistoryQuery>, environment = env.FAREJADOR_ENV, db: Pool = pool) {
  const search = f.q.replace(/^#/, '').replace(/[\\%_]/g, '\\$&');
  // Usa a mesma memória de cálculo do painel. Nenhum comprovante sugerido vira despesa.
  const result = await db.query(`WITH base AS (
    ${tripSelect} AND t.status='closed'
      AND COALESCE(t.ended_at,t.started_at)>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND COALESCE(t.ended_at,t.started_at)<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
  ), scoped AS (
    SELECT *, round(COALESCE((resumo->>'frete_total')::numeric,0)
      + COALESCE((resumo->>'lucro_pneus')::numeric,0) - despesas_total::numeric,2) AS result_amount
    FROM base WHERE ($4='' OR concat_ws(' ',trip_number,courier_name) ILIKE '%' || $4 || '%')
      AND ($5='' OR COALESCE(courier_collaborator_id::text,'name:' || courier_name)=$5)
      AND ($6='all' OR financial_status=$6 OR ($6='pending' AND financial_status='divergent'))
  ), summary AS (
    SELECT count(*)::int AS closed,
      count(*) FILTER (WHERE financial_status='reconciled')::int AS reconciled,
      count(*) FILTER (WHERE financial_status<>'reconciled')::int AS pending,
      COALESCE(sum(result_amount) FILTER (WHERE financial_status='reconciled'),0)::text AS result
    FROM scoped
  ), pagination AS (
    SELECT LEAST($7::int,GREATEST(1,ceil(closed::numeric/6)::int)) AS page FROM summary
  ), page_rows AS (
    SELECT * FROM scoped ORDER BY COALESCE(ended_at,started_at) DESC,id DESC
    LIMIT 6 OFFSET (SELECT (page-1)*6 FROM pagination)
  ) SELECT (SELECT row_to_json(summary) FROM summary) AS summary,
    (SELECT page FROM pagination) AS page, 6 AS page_size,
    COALESCE((SELECT jsonb_agg(p ORDER BY COALESCE(p.ended_at,p.started_at) DESC,p.id DESC) FROM page_rows p),'[]'::jsonb) AS rows,
    COALESCE((SELECT jsonb_agg(c ORDER BY c.name,c.id) FROM (
      SELECT COALESCE(courier_collaborator_id::text,'name:' || courier_name) AS id,max(courier_name) AS name
      FROM base GROUP BY COALESCE(courier_collaborator_id::text,'name:' || courier_name)) c),'[]'::jsonb) AS couriers,
    now() AS as_of`, [environment, f.from, f.to, search, f.courier, f.financial, f.page]);
  return result.rows[0];
}

export async function listClosedTripDeliveries(tripId: string, environment = env.FAREJADOR_ENV, db: Pool = pool) {
  const result = await db.query(`WITH trip AS (
    SELECT id FROM commerce.matriz_delivery_trips WHERE id=$2 AND environment=$1 AND status='closed' AND deleted_at IS NULL
  ) SELECT o.id::text AS id,o.id AS order_id,o.order_number,COALESCE(c.name,cu.name) AS customer_name,
      CASE WHEN o.status='cancelled' THEN 'cancelled' ELSE o.delivery_status END AS status,
      o.total_amount::text,o.delivery_failure_reason AS reason,false AS historical
    FROM commerce.orders o JOIN trip t ON t.id=o.trip_id
    JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
    LEFT JOIN core.contacts c ON c.id=o.contact_id AND c.environment=o.environment
    LEFT JOIN commerce.customers cu ON cu.id=o.customer_id AND cu.environment=o.environment
    WHERE o.environment=$1 AND o.fulfillment_mode='delivery'
    UNION ALL
    SELECT 'history:' || a.id::text,a.entity_id::uuid,o.order_number,COALESCE(c.name,cu.name),
      'failed',NULL,a.payload_before->>'delivery_failure_reason',true
    FROM audit.events a JOIN trip t ON t.id::text=a.payload_before->>'trip_id'
    LEFT JOIN commerce.orders o ON o.id::text=a.entity_id::text AND o.environment=$1
    LEFT JOIN core.contacts c ON c.id=o.contact_id AND c.environment=o.environment
    LEFT JOIN commerce.customers cu ON cu.id=o.customer_id AND cu.environment=o.environment
    WHERE a.environment=$1::text AND a.domain='matriz_logistics' AND a.entity_table='commerce.orders'
      AND a.event_type='delivery_report_detached_on_trip_close'
    ORDER BY historical,order_number,id`, [environment, tripId]);
  return { rows: result.rows };
}
