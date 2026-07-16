import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { hasMatrizPayrollSchema } from './payroll-schema.js';

type Queryable = Pick<Pool, 'query'>;
type WorkArea = 'sales' | 'delivery' | 'administrative' | 'workshop' | 'other';
type CommissionBasis = 'margin' | 'revenue' | 'sale' | 'delivery' | 'trip';

export interface CollaboratorManagementRow {
  id: string; display_name: string; username: string; job: string; job_title: string;
  work_area: WorkArea; panel_role: 'owner' | 'admin' | null; active: boolean;
  employment_type: string | null; base_salary: number; monthly_base_salary: number; payment_day: number | null;
  payment_method: string | null; payment_note: string | null; compensation_starts_on: string | null;
  commission_kind: 'percent' | 'fixed' | null; commission_basis: CommissionBasis | null;
  commission_value: number; commission_starts_on: string | null; commission_active: boolean;
  sales_count: number; revenue: number; margin: number; items_without_cost: number; deliveries_count: number;
  trips_count: number; distance_km: number; on_time_pct: number | null;
  additions: number; deductions: number; commission_amount: number; total_due: number;
  payroll_item_id: string | null; payroll_status: 'preview' | 'pending' | 'paid';
  payroll_due_date: string | null; payroll_paid_at: string | null; source_expense_id: string | null;
}

function n(value: unknown): number { return Number(value ?? 0); }
async function runSequential(queries: Array<() => Promise<any>>): Promise<any[]> {
  const results = [];
  for (const query of queries) results.push(await query());
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
  // acidental no pg 9), portanto estas quatro leituras sao deliberadamente sequenciais.
  const [people, performance, adjustments, payroll] = await runSequential([
    () => db.query<any>(
      `SELECT mc.id, mc.display_name, pp.username, mc.job, mc.job_title, mc.work_area,
              mc.panel_role, mc.revoked_at IS NULL AS active,
              cp.employment_type, COALESCE(cp.base_salary, 0) AS monthly_base_salary,
              COALESCE(cp.base_salary, 0) AS base_salary,
              cp.payment_day, cp.payment_method, cp.payment_note, cp.starts_on AS compensation_starts_on,
              cr.kind AS commission_kind, cr.basis AS commission_basis,
              COALESCE(cr.value, 0) AS commission_value, cr.starts_on AS commission_starts_on,
              COALESCE(cr.active, false) AS commission_active
         FROM network.matriz_collaborators mc
         JOIN network.partner_people pp ON pp.id = mc.person_id
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
         -- Venda conta na competencia de created_at. Cancelada antes do
         -- fechamento sai da apuracao; salario nao tem rateio por dia.
         SELECT o.seller_collaborator_id AS id, 'sale'::text AS event_type,
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
            AND o.status <> 'cancelled'
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
       ), wholesale AS (
         SELECT o.seller_collaborator_id AS id, 'sale'::text AS event_type,
                (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS event_date,
                1::int AS sales_count, o.total_amount AS revenue, items.margin,
                0::int AS items_without_cost, 0::int AS deliveries_count, 0::int AS trips_count,
                0::numeric AS distance_km, NULL::boolean AS on_time
           FROM commerce.wholesale_orders o
           LEFT JOIN LATERAL (
             SELECT COALESCE(sum((oi.unit_price-oi.unit_cost)*oi.quantity),0) AS margin
               FROM commerce.wholesale_order_items oi WHERE oi.order_id=o.id AND oi.environment=o.environment
           ) items ON true
          WHERE o.environment=$1 AND o.seller_collaborator_id IS NOT NULL AND o.status='confirmed'
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
       ), trip_events AS (
         SELECT t.courier_collaborator_id AS id, 'trip'::text AS event_type,
                (t.ended_at AT TIME ZONE 'America/Sao_Paulo')::date AS event_date,
                0::int AS sales_count, 0::numeric AS revenue, 0::numeric AS margin,
                0::int AS items_without_cost, 0::int AS deliveries_count, 1::int AS trips_count,
                GREATEST(COALESCE(t.km_end,t.km_start)-t.km_start,0) AS distance_km,
                NULL::boolean AS on_time
           FROM commerce.matriz_delivery_trips t
          WHERE t.environment=$1 AND t.courier_collaborator_id IS NOT NULL
            AND t.deleted_at IS NULL AND t.status='closed' AND t.ended_at IS NOT NULL
            AND (t.ended_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND (t.ended_at AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
       ), delivery_events AS (
         SELECT t.courier_collaborator_id AS id, 'delivery'::text AS event_type,
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
         SELECT e.*, cr.kind, cr.basis, cr.value, cr.active,
                CASE
                  WHEN cr.active AND cr.kind='percent' AND cr.basis='margin' THEN e.margin*cr.value/100
                  WHEN cr.active AND cr.kind='percent' AND cr.basis='revenue' THEN e.revenue*cr.value/100
                  WHEN cr.active AND cr.kind='fixed' AND cr.basis='sale' AND e.event_type='sale' THEN cr.value
                  WHEN cr.active AND cr.kind='fixed' AND cr.basis='delivery' AND e.event_type='delivery' THEN cr.value
                  WHEN cr.active AND cr.kind='fixed' AND cr.basis='trip' AND e.event_type='trip' THEN cr.value
                  ELSE 0 END AS commission_amount
           FROM events e
           LEFT JOIN LATERAL (
             SELECT r.kind,r.basis,r.value,r.active FROM network.matriz_collaborator_commission_rules r
              WHERE r.collaborator_id=e.id AND r.environment=$1
                AND r.starts_on <= e.event_date
              ORDER BY r.starts_on DESC LIMIT 1
           ) cr ON true
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
      `SELECT collaborator_id,
              COALESCE(sum(amount) FILTER (WHERE kind='addition'),0) additions,
              COALESCE(sum(amount) FILTER (WHERE kind='deduction'),0) deductions
         FROM finance.matriz_payroll_adjustments
        WHERE environment=$1 AND competence=$2::date AND deleted_at IS NULL GROUP BY collaborator_id`,
      [environment, competence]),
    () => db.query<any>(
      `SELECT i.collaborator_id, i.id payroll_item_id, i.base_salary, i.commission_amount,
              i.additions, i.deductions, i.total_due, i.payment_status payroll_status,
              i.due_date payroll_due_date, i.paid_at payroll_paid_at, i.source_expense_id,
              p.id payroll_period_id, p.status payroll_period_status
         FROM finance.matriz_payroll_periods p
         JOIN finance.matriz_payroll_items i ON i.payroll_period_id=p.id
        WHERE p.environment=$1 AND p.competence=$2::date`, [environment, competence]),
  ]);

  const perf = new Map(performance.rows.map((r: any) => [r.id, r]));
  const adj = new Map(adjustments.rows.map((r: any) => [r.collaborator_id, r]));
  const frozen = new Map(payroll.rows.map((r: any) => [r.collaborator_id, r]));
  const rows: CollaboratorManagementRow[] = people.rows.map((p: any) => {
    const q = perf.get(p.id) as any ?? {}; const a = adj.get(p.id) as any ?? {}; const f = frozen.get(p.id) as any;
    const row: CollaboratorManagementRow = {
      ...p, base_salary: n(p.base_salary), monthly_base_salary: n(p.monthly_base_salary),
      payment_day: p.payment_day === null ? null : n(p.payment_day),
      commission_value: n(p.commission_value), commission_active: Boolean(p.commission_active),
      sales_count: n(q.sales_count), revenue: n(q.revenue), margin: n(q.margin), items_without_cost: n(q.items_without_cost),
      deliveries_count: n(q.deliveries_count), trips_count: n(q.trips_count), distance_km: n(q.distance_km),
      on_time_pct: q.on_time_pct === null || q.on_time_pct === undefined ? null : n(q.on_time_pct),
      additions: n(a.additions), deductions: n(a.deductions), commission_amount: 0, total_due: 0,
      payroll_item_id: f?.payroll_item_id ?? null, payroll_status: f?.payroll_status ?? 'preview',
      payroll_due_date: f?.payroll_due_date ?? null, payroll_paid_at: f?.payroll_paid_at ?? null,
      source_expense_id: f?.source_expense_id ?? null,
    };
    row.commission_amount = f ? n(f.commission_amount) : n(q.commission_amount);
    if (f) Object.assign(row, { base_salary: n(f.base_salary), additions: n(f.additions), deductions: n(f.deductions) });
    row.total_due = f ? n(f.total_due) : Math.max(0, Math.round((row.base_salary + row.commission_amount + row.additions - row.deductions) * 100) / 100);
    return row;
  });
  const active = rows.filter((r) => r.active);
  const payrollRows = payroll.rows.length ? rows.filter((r) => r.payroll_item_id) : active;
  const payable = rows.filter((r) => r.payroll_status === 'pending');
  const paid = rows.filter((r) => r.payroll_status === 'paid');
  const summary = {
    active_count: active.length, role_count: new Set(active.map((r) => r.job_title)).size,
    panel_access_count: active.filter((r) => r.panel_role).length, revoked_count: rows.length - active.length,
    configured_count: active.filter((r) => r.employment_type).length,
    base_salary_total: active.reduce((s, r) => s + r.base_salary, 0),
    unconfigured_count: active.filter((r) => !r.employment_type).length,
    commission_total: active.reduce((s, r) => s + r.commission_amount, 0),
    sales_eligible: active.reduce((s, r) => s + r.sales_count, 0),
    deliveries_eligible: active.reduce((s, r) => s + r.deliveries_count, 0),
    without_rule: active.filter((r) => !r.commission_active).length,
    payroll_total: payrollRows.reduce((s, r) => s + r.total_due, 0),
    payroll_payable: payable.reduce((s, r) => s + r.total_due, 0),
    payroll_paid: paid.reduce((s, r) => s + r.total_due, 0), paid_count: paid.length,
    payroll_count: payroll.rows.length || active.filter((r) => r.employment_type || r.commission_active).length,
    payroll_period_id: payroll.rows[0]?.payroll_period_id ?? null,
    payroll_period_status: payroll.rows[0]?.payroll_period_status ?? 'preview',
    revenue: active.reduce((s, r) => s + r.revenue, 0), margin: active.reduce((s, r) => s + r.margin, 0),
    trips_count: active.reduce((s, r) => s + r.trips_count, 0),
  };
  return { competence, collaborators: rows, summary };
}
