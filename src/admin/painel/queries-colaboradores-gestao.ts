import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { hasMatrizPayrollSchema } from './payroll-schema.js';
import { buildMatrizCollaboratorManagement } from './queries-colaboradores-payroll-summary.js';
type Queryable = Pick<Pool, 'query'>;
export type { CollaboratorManagementRow } from './queries-colaboradores-payroll-summary.js';
async function runSequential(queries: Array<() => Promise<any>>): Promise<any[]> {
  const results = []; for (const query of queries) results.push(await query());
  return results;
}
export async function getMatrizCollaboratorManagement(
  competence: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  db: Queryable = defaultPool,
) {
  if (!(await hasMatrizPayrollSchema(db))) throw new Error('collaborator_management_unavailable');
  // closeMatrizPayroll chama esta leitura dentro de um PoolClient transacional.
  // pg nao aceita consultas concorrentes no mesmo client (e removera o suporte
  // acidental no pg 9), portanto estas leituras sao deliberadamente sequenciais.
  const [people, performance, adjustments, payroll, adjustmentDetails, assignmentGaps, payrollHistory] = await runSequential([
    () => db.query<any>(
      `SELECT mc.id, mc.display_name, pp.username, mc.job, mc.job_title, mc.work_area,
              mc.panel_role, mc.revoked_at IS NULL AS active, sessions.last_used_at,
              CASE WHEN mc.panel_role='owner' THEN true ELSE COALESCE(op.allow_vendas,mc.job='vendedor' AND mc.work_area='sales') END AS allow_vendas,
              CASE WHEN mc.panel_role='owner' THEN true ELSE COALESCE(op.allow_estoque,mc.job='vendedor' AND mc.work_area='sales') END AS allow_estoque,
              CASE WHEN mc.panel_role='owner' THEN true ELSE COALESCE(op.allow_entregas,mc.job='entregador') END AS allow_entregas,
              CASE WHEN mc.panel_role='owner' THEN true ELSE COALESCE(op.allow_financeiro,mc.panel_role IS NOT NULL) END AS allow_financeiro,
              finance.matriz_collaborator_employed_in_competence(
                mc.environment,mc.id,$2::date) AS eligible_in_competence,
              cp.employment_type, COALESCE(cp.base_salary, 0) AS monthly_base_salary,
              CASE WHEN COALESCE(cp.salary_frequency,'monthly')='weekly' THEN 0 ELSE COALESCE(cp.base_salary,0) END AS base_salary,
              COALESCE(cp.salary_frequency,'monthly') AS salary_frequency,
              cp.payment_day, cp.payment_method, cp.payment_note, cp.starts_on AS compensation_starts_on,
              COALESCE(cp.benefits,'[]'::jsonb) AS benefits,
              cr.kind AS commission_kind, cr.basis AS commission_basis,
              COALESCE(cr.value, 0) AS commission_value, cr.starts_on AS commission_starts_on,
              COALESCE(cr.active, false) AS commission_active,
              COALESCE(cr.itemized,false) AS commission_itemized,
              COALESCE(cr.item_rules,'{}'::jsonb) AS commission_item_rules,
              COALESCE(cr.settlement_frequency,'monthly') AS commission_settlement_frequency
         FROM network.matriz_collaborators mc
         JOIN network.partner_people pp ON pp.id = mc.person_id
         LEFT JOIN network.matriz_collaborator_operation_permissions op ON op.collaborator_id=mc.id AND op.environment=mc.environment
         LEFT JOIN LATERAL (SELECT max(s.last_used_at) AS last_used_at
           FROM network.matriz_staff_sessions s
          WHERE s.environment=mc.environment AND s.person_id=mc.person_id) sessions ON true
         LEFT JOIN LATERAL (
           SELECT h.* FROM network.matriz_collaborator_compensation h
            WHERE h.collaborator_id=mc.id AND h.environment=mc.environment
              AND h.starts_on < ($2::date + interval '1 month')::date
            ORDER BY h.starts_on DESC LIMIT 1
         ) cp ON true
         LEFT JOIN LATERAL (
           SELECT h.* FROM network.matriz_collaborator_commission_rules h
            WHERE h.collaborator_id=mc.id AND h.environment=mc.environment
              AND h.starts_on < ($2::date + interval '1 month')::date
            ORDER BY h.starts_on DESC LIMIT 1
         ) cr ON true
        WHERE mc.environment = $1
        ORDER BY (mc.revoked_at IS NULL) DESC, mc.display_name`, [environment, competence]),
    () => db.query<any>(
       `WITH retail AS (
         -- Varejo conta na competencia de created_at. Cancelada antes do
         -- fechamento sai da apuracao; salario nao tem rateio por dia.
         SELECT o.seller_collaborator_id AS id, 'sale'::text AS event_type,
                o.id AS source_id, 'retail'::text AS sale_channel,
                (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS event_date,
                1::int AS sales_count, o.total_amount AS revenue, items.margin,
                items.items_without_cost, 0::int AS deliveries_count, 0::int AS trips_count,
                0::numeric AS distance_km, NULL::boolean AS on_time
           FROM commerce.orders o
           JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
           LEFT JOIN LATERAL (
             SELECT COALESCE(sum((oi.unit_price-oi.matriz_unit_cost)*oi.quantity-oi.discount_amount)
                       FILTER (WHERE oi.matriz_unit_cost IS NOT NULL),0) AS margin,
                    count(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int AS items_without_cost
               FROM commerce.order_items oi WHERE oi.order_id=o.id AND oi.environment=o.environment
           ) items ON true
          WHERE o.environment=$1 AND o.seller_collaborator_id IS NOT NULL
            AND o.status IN ('confirmed','paid','delivered')
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
       ), wholesale AS (
         SELECT o.seller_collaborator_id AS id, 'sale'::text AS event_type,
                o.id AS source_id, 'wholesale'::text AS sale_channel,
                ((CASE WHEN o.partner_transfer_status IN ('settled','received')
                    THEN COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END)
                  AT TIME ZONE 'America/Sao_Paulo')::date AS event_date,
                1::int AS sales_count,
                COALESCE(o.settled_total_amount,o.total_amount) AS revenue, items.margin,
                0::int AS items_without_cost, 0::int AS deliveries_count, 0::int AS trips_count,
                0::numeric AS distance_km, NULL::boolean AS on_time
           FROM commerce.wholesale_orders o
           LEFT JOIN LATERAL (
             SELECT COALESCE(sum((oi.unit_price-oi.unit_cost)*CASE
                      WHEN o.partner_transfer_status IN ('settled','received')
                        THEN COALESCE(oi.accepted_quantity,0) ELSE oi.quantity END),0) AS margin
               FROM commerce.wholesale_order_items oi WHERE oi.order_id=o.id AND oi.environment=o.environment
           ) items ON true
          WHERE o.environment=$1 AND o.seller_collaborator_id IS NOT NULL AND o.status='confirmed'
            AND (o.partner_transfer_status IS NULL
              OR o.partner_transfer_status IN ('settled','received'))
            AND ((CASE WHEN o.partner_transfer_status IN ('settled','received')
                   THEN COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END)
                 AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND ((CASE WHEN o.partner_transfer_status IN ('settled','received')
                   THEN COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END)
                 AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
       ), trip_events AS (
         SELECT t.courier_collaborator_id AS id, 'trip'::text AS event_type,
                t.id AS source_id, NULL::text AS sale_channel,
                (t.ended_at AT TIME ZONE 'America/Sao_Paulo')::date AS event_date,
                0::int AS sales_count, 0::numeric AS revenue, 0::numeric AS margin,
                0::int AS items_without_cost, 0::int AS deliveries_count, 1::int AS trips_count,
                GREATEST(COALESCE(t.km_end,t.km_start)-t.km_start,0) AS distance_km,
                NULL::boolean AS on_time
           FROM commerce.matriz_delivery_trips t
          WHERE t.environment=$1 AND t.courier_collaborator_id IS NOT NULL
            AND t.deleted_at IS NULL AND t.status='closed' AND t.ended_at IS NOT NULL
            AND commerce.matriz_trip_financial_status(t.id,t.environment)='reconciled'
            AND (t.ended_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND (t.ended_at AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
       ), delivery_events AS (
         SELECT t.courier_collaborator_id AS id, 'delivery'::text AS event_type,
                o.id AS source_id, NULL::text AS sale_channel,
                (o.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date AS event_date,
                0::int AS sales_count, 0::numeric AS revenue, 0::numeric AS margin,
                0::int AS items_without_cost, 1::int AS deliveries_count, 0::int AS trips_count,
                0::numeric AS distance_km,
                (o.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date <= COALESCE(
                  o.scheduled_delivery_date,
                  (o.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date
                ) AS on_time
           FROM commerce.matriz_delivery_trips t
           JOIN commerce.orders o ON o.trip_id=t.id AND o.environment=t.environment
          WHERE t.environment=$1 AND t.courier_collaborator_id IS NOT NULL AND t.deleted_at IS NULL
            AND o.delivery_status='delivered' AND o.delivered_at IS NOT NULL
            AND (o.delivered_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND (o.delivered_at AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
       ), events AS (
         SELECT * FROM retail UNION ALL SELECT * FROM wholesale
         UNION ALL SELECT * FROM trip_events UNION ALL SELECT * FROM delivery_events
       ), ruled AS (
         SELECT e.*, cr.kind, cr.basis, cr.value, cr.active,cr.itemized,cr.item_rules,
                cr.settlement_frequency,
                round(CASE
                  WHEN cr.settlement_frequency='weekly' THEN 0
                  WHEN cr.active AND cr.itemized AND e.event_type='sale' AND e.sale_channel='retail'
                    THEN finance.matriz_retail_itemized_commission($1,e.source_id,cr.item_rules)
                  WHEN cr.active AND cr.itemized AND e.event_type='sale' AND e.sale_channel='wholesale'
                    THEN finance.matriz_wholesale_itemized_commission($1,e.source_id,cr.item_rules)
                  WHEN cr.active AND cr.kind='percent' AND cr.basis='margin' THEN e.margin*cr.value/100
                  WHEN cr.active AND cr.kind='percent' AND cr.basis='revenue' THEN e.revenue*cr.value/100
                  WHEN cr.active AND cr.kind='fixed' AND cr.basis='sale' AND e.event_type='sale' THEN cr.value
                  WHEN cr.active AND cr.kind='fixed' AND cr.basis='delivery' AND e.event_type='delivery' THEN cr.value
                  WHEN cr.active AND cr.kind='fixed' AND cr.basis='trip' AND e.event_type='trip' THEN cr.value
                  ELSE 0 END,2) AS commission_amount
           FROM events e
           LEFT JOIN LATERAL (
             SELECT r.kind,r.basis,r.value,r.active,r.itemized,r.item_rules,
                    r.settlement_frequency
               FROM network.matriz_collaborator_commission_rules r
              WHERE r.collaborator_id=e.id AND r.environment=$1
                AND r.starts_on <= e.event_date
              ORDER BY r.starts_on DESC LIMIT 1
           ) cr ON true
          WHERE finance.matriz_collaborator_employed_on($1,e.id,e.event_date)
       )
       SELECT id, sum(sales_count)::int sales_count, sum(revenue) revenue, sum(margin) margin,
              sum(items_without_cost)::int items_without_cost,
              sum(deliveries_count)::int deliveries_count, sum(trips_count)::int trips_count,
              sum(distance_km) distance_km,
              CASE WHEN sum(deliveries_count)=0 THEN NULL ELSE
                round(100.0*count(*) FILTER (WHERE event_type='delivery' AND on_time)
                  / sum(deliveries_count),1) END AS on_time_pct,
              round(sum(commission_amount),2) AS commission_amount
         FROM ruled GROUP BY id`, [environment, competence]),
    () => db.query<any>(
      `WITH remaining AS (
         SELECT a.collaborator_id,a.kind,
                a.amount-COALESCE(sum(al.amount),0) amount
           FROM finance.matriz_payroll_adjustments a
           LEFT JOIN finance.matriz_payroll_adjustment_allocations al
             ON al.environment=a.environment AND al.adjustment_id=a.id
          WHERE a.environment=$1 AND a.competence<=$2::date AND a.deleted_at IS NULL
            AND COALESCE(a.causal_status,'ready')<>'needs_review'
          GROUP BY a.id,a.collaborator_id,a.kind,a.amount
         HAVING a.amount-COALESCE(sum(al.amount),0)>0
       )
       SELECT collaborator_id,
              COALESCE(sum(amount) FILTER (WHERE kind='addition'),0) additions,
              COALESCE(sum(amount) FILTER (WHERE kind='deduction'),0) deductions
         FROM remaining GROUP BY collaborator_id`,
      [environment, competence]),
    () => db.query<any>(
      `SELECT i.collaborator_id, i.id payroll_item_id, i.base_salary, i.commission_amount,
              i.additions, i.deductions, i.total_due, i.payment_status payroll_status,
              i.due_date payroll_due_date, i.paid_at payroll_paid_at, i.source_expense_id,
              i.calculation payroll_calculation,
              p.id payroll_period_id, p.status payroll_period_status
         FROM finance.matriz_payroll_periods p
         JOIN finance.matriz_payroll_items i ON i.payroll_period_id=p.id
        WHERE p.environment=$1 AND p.competence=$2::date`, [environment, competence]),
    () => db.query<any>(
      `SELECT a.id,a.collaborator_id,a.kind,a.description,
              a.amount original_amount,
              a.amount-COALESCE(sum(al.amount),0) amount,a.competence,a.created_at,
              a.source_type,a.source_id,a.source_event_at,a.original_payroll_item_id,
              a.frozen_calculation,a.causal_status,a.reviewed_by,a.reviewed_at
         FROM finance.matriz_payroll_adjustments a
         LEFT JOIN finance.matriz_payroll_adjustment_allocations al
           ON al.environment=a.environment AND al.adjustment_id=a.id
        WHERE a.environment=$1 AND a.competence<=$2::date AND a.deleted_at IS NULL
        GROUP BY a.id
       HAVING a.amount-COALESCE(sum(al.amount),0)>0
        ORDER BY a.created_at,a.id`, [environment, competence]),
    () => db.query<{ missing_count: number }>(
      `SELECT COALESCE(sum(missing_count),0)::int AS missing_count
         FROM finance.matriz_payroll_assignment_gaps($1,$2::date)
        WHERE missing_count>0`, [environment, competence]),
    () => db.query<any>(
      `SELECT p.id,p.competence,p.status,p.closed_at,p.closed_by,
              count(i.id)::int AS collaborator_count,
              COALESCE(sum(i.total_due),0) AS total,
              count(i.id) FILTER (WHERE i.payment_status='pending')::int AS pending_count,
              COALESCE(sum(i.total_due) FILTER (WHERE i.payment_status='pending'),0) AS pending_total,
              count(i.id) FILTER (WHERE i.payment_status='paid')::int AS paid_count,
              COALESCE(sum(i.total_due) FILTER (WHERE i.payment_status='paid'),0) AS paid_total
         FROM finance.matriz_payroll_periods p
         LEFT JOIN finance.matriz_payroll_items i
           ON i.environment=p.environment AND i.payroll_period_id=p.id
        WHERE p.environment=$1
        GROUP BY p.id
        ORDER BY p.competence DESC
        LIMIT 12`, [environment]),
  ]);
  return buildMatrizCollaboratorManagement({
    competence, people, performance, adjustments, payroll, adjustmentDetails, assignmentGaps, payrollHistory,
  });
}
