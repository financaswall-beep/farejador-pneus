import type { Pool } from 'pg';
import {
  performanceMoney, teamPerformanceBounds,
  type TeamPerformanceCollaborator, type TeamPerformancePayload, type TeamPerformanceRange,
} from '../shared/operation-performance.js';
import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';

type Queryable = Pick<Pool, 'query'>;
type PerformanceRow = {
  id: string; name: string; role: string; work_area: string; active: boolean;
  sales_count: number; revenue: string; margin: string; installations_count: number;
  pickups_count: number; deliveries_count: number; average_service_minutes: string | null;
  commission_amount: string; missing_cost_items: number;
};

const realizedSql = `WITH realized AS (
  SELECT po.operator_token_id collaborator_id,
         (CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
               WHEN po.retrieved_at IS NOT NULL THEN po.retrieved_at
               ELSE COALESCE(po.closed_at,po.created_at) END
            AT TIME ZONE 'America/Sao_Paulo')::date occurred_on,
         po.total_amount revenue,COALESCE(items.margin,0) margin,
         COALESCE(items.missing_cost_items,0)::int missing_cost_items,
         CASE WHEN po.fulfillment_mode='pickup' AND po.pickup_installation_started_at IS NOT NULL
           AND po.retrieved_at IS NOT NULL THEN 1 ELSE 0 END installations_count,
         CASE WHEN po.fulfillment_mode='pickup' AND po.retrieved_at IS NOT NULL THEN 1 ELSE 0 END pickups_count,
         CASE WHEN po.fulfillment_mode='delivery' AND po.delivered_at IS NOT NULL THEN 1 ELSE 0 END deliveries_count,
         CASE WHEN po.pickup_arrived_at IS NOT NULL AND po.retrieved_at>=po.pickup_arrived_at
           THEN extract(epoch FROM (po.retrieved_at-po.pickup_arrived_at))/60 END service_minutes
    FROM commerce.partner_orders po
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum((oi.unit_price-oi.unit_cost_snapshot)*oi.quantity-oi.discount_amount)
               FILTER (WHERE oi.unit_cost_snapshot IS NOT NULL),0) margin,
             count(*) FILTER (WHERE COALESCE(oi.item_type,'pneu')='pneu'
               AND oi.unit_cost_snapshot IS NULL)::int missing_cost_items
        FROM commerce.partner_order_items oi
       WHERE oi.environment=po.environment AND oi.order_id=po.id
    ) items ON true
   WHERE po.environment=$1 AND po.unit_id=$2 AND po.deleted_at IS NULL
     AND po.status<>'cancelled'
     AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status IS DISTINCT FROM 'delivered')
     AND NOT po.awaiting_pickup
     AND (CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
               WHEN po.retrieved_at IS NOT NULL THEN po.retrieved_at
               ELSE COALESCE(po.closed_at,po.created_at) END
          AT TIME ZONE 'America/Sao_Paulo') >= $3::date
     AND (CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
               WHEN po.retrieved_at IS NOT NULL THEN po.retrieved_at
               ELSE COALESCE(po.closed_at,po.created_at) END
          AT TIME ZONE 'America/Sao_Paulo') < $4::date
), commissions AS (
  SELECT token_id,COALESCE(sum(amount),0) amount FROM (
    SELECT ce.token_id,ce.commission_amount amount
      FROM finance.partner_staff_commission_entries ce
     WHERE ce.environment=$1 AND ce.unit_id=$2 AND ce.status='earned'
       AND (ce.realized_at AT TIME ZONE 'America/Sao_Paulo') >= $3::date
       AND (ce.realized_at AT TIME ZONE 'America/Sao_Paulo') < $4::date
    UNION ALL
    SELECT ca.token_id,ca.amount
      FROM finance.partner_staff_commission_adjustments ca
     WHERE ca.environment=$1 AND ca.unit_id=$2
       AND (ca.occurred_at AT TIME ZONE 'America/Sao_Paulo') >= $3::date
       AND (ca.occurred_at AT TIME ZONE 'America/Sao_Paulo') < $4::date
  ) values_by_token GROUP BY token_id
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
    on_time_pct: null,
    average_service_minutes: row.average_service_minutes === null
      ? null : Math.round(Number(row.average_service_minutes)),
    commission_amount: performanceMoney(row.commission_amount),
    missing_cost_items: Number(row.missing_cost_items || 0),
  };
}

export async function getPartnerTeamPerformance(
  ctx: PartnerContext,
  range: TeamPerformanceRange,
  db?: Queryable,
): Promise<TeamPerformancePayload> {
  if (!db) {
    return withPartnerContext(ctx.partnerUnitId, async (client) => (
      getPartnerTeamPerformance(ctx, range, client)
    ));
  }
  const bounds = teamPerformanceBounds(range);
  // O escopo do parceiro já está plantado por withPartnerContext; todas as
  // consultas abaixo possuem exatamente quatro placeholders ($1..$4).
  const params = [ctx.environment, ctx.unitId, bounds.start, bounds.end];
  const [people, days, alerts] = await Promise.all([
    db.query<PerformanceRow>(
      `${realizedSql}, totals AS (
         SELECT collaborator_id,count(*)::int sales_count,COALESCE(sum(revenue),0)::numeric revenue,
                COALESCE(sum(margin),0)::numeric margin,
                sum(installations_count)::int installations_count,sum(pickups_count)::int pickups_count,
                sum(deliveries_count)::int deliveries_count,avg(service_minutes) average_service_minutes,
                sum(missing_cost_items)::int missing_cost_items
           FROM realized WHERE collaborator_id IS NOT NULL GROUP BY collaborator_id
       )
       SELECT pat.id,pat.name,
              pat.role_name role,
              CASE pat.job_role WHEN 'vendedor' THEN 'sales' WHEN 'estoque' THEN 'stock'
                WHEN 'entregador' THEN 'delivery' ELSE 'other' END work_area,
              pat.active,COALESCE(t.sales_count,0)::int sales_count,
              COALESCE(t.revenue,0)::text revenue,COALESCE(t.margin,0)::text margin,
              COALESCE(t.installations_count,0)::int installations_count,
              COALESCE(t.pickups_count,0)::int pickups_count,
              COALESCE(t.deliveries_count,0)::int deliveries_count,t.average_service_minutes::text,
              COALESCE(c.amount,0)::text commission_amount,
              COALESCE(t.missing_cost_items,0)::int missing_cost_items
         FROM network.partner_staff_directory() pat
         LEFT JOIN totals t ON t.collaborator_id=pat.id
         LEFT JOIN commissions c ON c.token_id=pat.id
        WHERE pat.active OR t.collaborator_id IS NOT NULL OR c.token_id IS NOT NULL
        ORDER BY COALESCE(t.revenue,0) DESC,name`, params),
    db.query<{ date: string; collaborator_id: string; sales_count: number; installations_count: number }>(
      `${realizedSql}, daily AS (
         SELECT occurred_on day,collaborator_id,count(*)::int sales_count,
                sum(installations_count)::int installations_count
           FROM realized WHERE collaborator_id IS NOT NULL GROUP BY occurred_on,collaborator_id
       )
       SELECT to_char(day,'YYYY-MM-DD') date,collaborator_id,sales_count,installations_count
         FROM daily ORDER BY day,collaborator_id`, params),
    db.query<{
      unassigned_sales: number; waiting_pickups: number; commission_review_count: number;
    }>(
      `${realizedSql}
       SELECT count(*) FILTER (WHERE collaborator_id IS NULL)::int unassigned_sales,
              (SELECT count(*)::int FROM commerce.partner_orders po
                WHERE po.environment=$1 AND po.unit_id=$2 AND po.deleted_at IS NULL
                  AND po.fulfillment_mode='pickup' AND po.awaiting_pickup) waiting_pickups,
              (SELECT count(*)::int FROM finance.partner_staff_commission_entries ce
                WHERE ce.environment=$1 AND ce.unit_id=$2 AND ce.status='earned'
                  AND ce.settlement_period_id IS NULL
                  AND (ce.realized_at AT TIME ZONE 'America/Sao_Paulo') >= $3::date
                  AND (ce.realized_at AT TIME ZONE 'America/Sao_Paulo') < $4::date)
                commission_review_count
         FROM realized`, params),
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
    range, period_start: bounds.start, period_end: bounds.end, unit_name: ctx.unitName, summary,
    daily: days.rows.map((row) => ({
      date: row.date, collaborator_id: row.collaborator_id,
      sales_count: Number(row.sales_count || 0),
      installations_count: Number(row.installations_count || 0),
    })), collaborators,
  };
}
