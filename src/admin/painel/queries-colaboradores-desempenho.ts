import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  performanceMoney, teamPerformanceBounds,
  type TeamPerformanceCollaborator, type TeamPerformancePayload, type TeamPerformanceRange,
} from '../../shared/operation-performance.js';
import { matrizCommissionFactsSql } from '../caixa/operation-commission-facts.js';

type Queryable = Pick<Pool, 'query'>;

type PerformanceRow = {
  id: string; name: string; role: string; work_area: string; active: boolean;
  sales_count: number; revenue: string; margin: string; installations_count: number;
  pickups_count: number; deliveries_count: number; on_time_pct: string | null;
  average_service_minutes: string | null; commission_amount: string; missing_cost_items: number;
};

const installationsSql = `installations AS (
  SELECT o.seller_collaborator_id collaborator_id,
         (o.retrieved_at AT TIME ZONE 'America/Sao_Paulo')::date occurred_on,
         CASE WHEN o.pickup_installation_started_at IS NOT NULL THEN 1 ELSE 0 END installations_count,
         1::int pickups_count,
         CASE WHEN o.pickup_arrived_at IS NOT NULL AND o.retrieved_at>=o.pickup_arrived_at
           THEN extract(epoch FROM (o.retrieved_at-o.pickup_arrived_at))/60 END service_minutes
    FROM commerce.orders o
    JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
   WHERE o.environment=$1 AND o.seller_collaborator_id IS NOT NULL
     AND o.fulfillment_mode='pickup' AND o.retrieved_at IS NOT NULL
     AND o.status IN ('paid','delivered','confirmed')
     AND (o.retrieved_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
     AND (o.retrieved_at AT TIME ZONE 'America/Sao_Paulo') < $3::date
)`;

function collaboratorOf(row: PerformanceRow): TeamPerformanceCollaborator {
  const sales = Number(row.sales_count || 0);
  const revenue = performanceMoney(row.revenue);
  return {
    id: row.id, name: row.name, role: row.role, work_area: row.work_area,
    active: Boolean(row.active), sales_count: sales, revenue,
    margin: performanceMoney(row.margin), average_ticket: sales ? performanceMoney(revenue / sales) : 0,
    installations_count: Number(row.installations_count || 0),
    pickups_count: Number(row.pickups_count || 0), deliveries_count: Number(row.deliveries_count || 0),
    on_time_pct: row.on_time_pct === null ? null : Number(row.on_time_pct),
    average_service_minutes: row.average_service_minutes === null
      ? null : Math.round(Number(row.average_service_minutes)),
    commission_amount: performanceMoney(row.commission_amount),
    missing_cost_items: Number(row.missing_cost_items || 0),
  };
}

export async function getMatrizTeamPerformance(
  range: TeamPerformanceRange,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  db: Queryable = defaultPool,
): Promise<TeamPerformancePayload> {
  const bounds = teamPerformanceBounds(range);
  const [people, days, alerts] = await Promise.all([
    db.query<PerformanceRow>(
      `${matrizCommissionFactsSql}, ${installationsSql}, event_totals AS (
         SELECT collaborator_id,
                count(*) FILTER (WHERE event_type='sale')::int sales_count,
                COALESCE(sum(gross_amount) FILTER (WHERE event_type='sale'),0)::numeric revenue,
                COALESCE(sum(margin) FILTER (WHERE event_type='sale'),0)::numeric margin,
                count(*) FILTER (WHERE event_type='delivery')::int deliveries_count,
                NULL::numeric on_time_pct,
                COALESCE(sum(commission_amount),0)::numeric commission_amount,
                COALESCE(sum(items_without_cost) FILTER (WHERE event_type='sale'),0)::int missing_cost_items
           FROM ruled GROUP BY collaborator_id
       ), pickup_totals AS (
         SELECT collaborator_id,sum(installations_count)::int installations_count,
                sum(pickups_count)::int pickups_count,avg(service_minutes) average_service_minutes
           FROM installations GROUP BY collaborator_id
       )
       SELECT mc.id,mc.display_name name,mc.job_title role,mc.work_area,
              mc.revoked_at IS NULL active,COALESCE(e.sales_count,0)::int sales_count,
              COALESCE(e.revenue,0)::text revenue,COALESCE(e.margin,0)::text margin,
              COALESCE(p.installations_count,0)::int installations_count,
              COALESCE(p.pickups_count,0)::int pickups_count,
              COALESCE(e.deliveries_count,0)::int deliveries_count,e.on_time_pct::text,
              p.average_service_minutes::text,COALESCE(e.commission_amount,0)::text commission_amount,
              COALESCE(e.missing_cost_items,0)::int missing_cost_items
         FROM network.matriz_collaborators mc
         LEFT JOIN event_totals e ON e.collaborator_id=mc.id
         LEFT JOIN pickup_totals p ON p.collaborator_id=mc.id
        WHERE mc.environment=$1 AND (mc.revoked_at IS NULL OR e.collaborator_id IS NOT NULL
          OR p.collaborator_id IS NOT NULL)
        ORDER BY COALESCE(e.revenue,0) DESC,mc.display_name`,
      [environment, bounds.start, bounds.end],
    ),
    db.query<{ date: string; collaborator_id: string; sales_count: number; installations_count: number }>(
      `${matrizCommissionFactsSql}, ${installationsSql}, sales_daily AS (
         SELECT (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date day,collaborator_id,
                count(*) FILTER (WHERE event_type='sale')::int sales_count
           FROM ruled GROUP BY 1,2
       ), pickup_daily AS (
         SELECT occurred_on day,collaborator_id,sum(installations_count)::int installations_count
           FROM installations GROUP BY occurred_on,collaborator_id
       ), keys AS (
         SELECT day,collaborator_id FROM sales_daily UNION SELECT day,collaborator_id FROM pickup_daily
       )
       SELECT to_char(k.day,'YYYY-MM-DD') date,k.collaborator_id,
              COALESCE(s.sales_count,0)::int sales_count,
              COALESCE(p.installations_count,0)::int installations_count
         FROM keys k LEFT JOIN sales_daily s USING(day,collaborator_id)
         LEFT JOIN pickup_daily p USING(day,collaborator_id) ORDER BY k.day,k.collaborator_id`,
      [environment, bounds.start, bounds.end],
    ),
    db.query<{
      unassigned_sales: number; waiting_pickups: number; commission_review_count: number;
    }>(
      `WITH bounds AS (SELECT $2::date start_date,$3::date end_date)
       SELECT
         ((SELECT count(*) FROM commerce.orders o JOIN core.units u
             ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main',bounds b
            WHERE o.environment=$1 AND o.status IN ('confirmed','paid','delivered')
              AND o.seller_collaborator_id IS NULL
              AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')>=b.start_date
              AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')<b.end_date)
          +(SELECT count(*) FROM commerce.wholesale_orders o,bounds b
            WHERE o.environment=$1 AND o.status='confirmed' AND o.seller_collaborator_id IS NULL
              AND (o.sold_at AT TIME ZONE 'America/Sao_Paulo')>=b.start_date
              AND (o.sold_at AT TIME ZONE 'America/Sao_Paulo')<b.end_date))::int unassigned_sales,
         (SELECT count(*)::int FROM commerce.orders o JOIN core.units u
             ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
           WHERE o.environment=$1 AND o.fulfillment_mode='pickup' AND o.status='open'
             AND o.partner_order_id IS NULL) waiting_pickups,
         (SELECT count(*)::int FROM finance.matriz_payroll_adjustments a,bounds b
           WHERE a.environment=$1 AND a.deleted_at IS NULL AND a.causal_status='needs_review'
             AND a.competence>=date_trunc('month',b.start_date)::date
             AND a.competence<date_trunc('month',b.end_date-1)+interval '1 month')::date)
           commission_review_count`,
      [environment, bounds.start, bounds.end],
    ),
  ]);
  const collaborators = people.rows.map(collaboratorOf);
  const summary = collaborators.reduce((acc, row) => ({
    sales_count: acc.sales_count + row.sales_count,
    revenue: performanceMoney(acc.revenue + row.revenue),
    margin: performanceMoney(acc.margin + row.margin),
    installations_count: acc.installations_count + row.installations_count,
    deliveries_count: acc.deliveries_count + row.deliveries_count,
    commission_total: performanceMoney(acc.commission_total + row.commission_amount),
    commission_collaborators: acc.commission_collaborators + (row.commission_amount !== 0 ? 1 : 0),
    unassigned_sales: acc.unassigned_sales, waiting_pickups: acc.waiting_pickups,
    commission_review_count: acc.commission_review_count,
    missing_cost_items: acc.missing_cost_items + row.missing_cost_items,
  }), {
    sales_count: 0, revenue: 0, margin: 0, installations_count: 0, deliveries_count: 0,
    commission_total: 0, commission_collaborators: 0,
    unassigned_sales: Number(alerts.rows[0]?.unassigned_sales || 0),
    waiting_pickups: Number(alerts.rows[0]?.waiting_pickups || 0),
    commission_review_count: Number(alerts.rows[0]?.commission_review_count || 0),
    missing_cost_items: 0,
  });
  return {
    range, period_start: bounds.start, period_end: bounds.end, unit_name: 'Matriz', summary,
    daily: days.rows.map((row) => ({
      date: row.date, collaborator_id: row.collaborator_id,
      sales_count: Number(row.sales_count || 0),
      installations_count: Number(row.installations_count || 0),
    })), collaborators,
  };
}
