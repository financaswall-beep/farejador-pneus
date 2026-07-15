import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

type Queryable = Pick<Pool, 'query'>;
type WorkArea = 'sales' | 'delivery' | 'administrative' | 'workshop' | 'other';
type CommissionBasis = 'margin' | 'revenue' | 'sale' | 'delivery' | 'trip';

export interface CollaboratorManagementRow {
  id: string; display_name: string; username: string; job: string; job_title: string;
  work_area: WorkArea; panel_role: 'owner' | 'admin' | null; active: boolean;
  employment_type: string | null; base_salary: number; payment_day: number | null;
  payment_method: string | null; payment_note: string | null; compensation_starts_on: string | null;
  commission_kind: 'percent' | 'fixed' | null; commission_basis: CommissionBasis | null;
  commission_value: number; commission_starts_on: string | null; commission_active: boolean;
  sales_count: number; revenue: number; margin: number; deliveries_count: number;
  trips_count: number; distance_km: number; on_time_pct: number | null;
  additions: number; deductions: number; commission_amount: number; total_due: number;
  payroll_item_id: string | null; payroll_status: 'preview' | 'pending' | 'paid';
  payroll_due_date: string | null; payroll_paid_at: string | null; source_expense_id: string | null;
}

function n(value: unknown): number { return Number(value ?? 0); }
function commissionFor(row: CollaboratorManagementRow): number {
  if (!row.commission_active || !row.commission_kind || !row.commission_basis) return 0;
  const bases: Record<CommissionBasis, number> = {
    margin: row.margin, revenue: row.revenue, sale: row.sales_count,
    delivery: row.deliveries_count, trip: row.trips_count,
  };
  const base = bases[row.commission_basis];
  return Math.round((row.commission_kind === 'percent' ? base * row.commission_value / 100 : base * row.commission_value) * 100) / 100;
}

export async function getMatrizCollaboratorManagement(
  competence: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  db: Queryable = defaultPool,
) {
  const [people, performance, adjustments, payroll] = await Promise.all([
    db.query<any>(
      `SELECT mc.id, mc.display_name, pp.username, mc.job, mc.job_title, mc.work_area,
              mc.panel_role, mc.revoked_at IS NULL AS active,
              cp.employment_type, COALESCE(cp.base_salary, 0) AS base_salary,
              cp.payment_day, cp.payment_method, cp.payment_note, cp.starts_on AS compensation_starts_on,
              cr.kind AS commission_kind, cr.basis AS commission_basis,
              COALESCE(cr.value, 0) AS commission_value, cr.starts_on AS commission_starts_on,
              COALESCE(cr.active, false) AS commission_active
         FROM network.matriz_collaborators mc
         JOIN network.partner_people pp ON pp.id = mc.person_id
         LEFT JOIN network.matriz_collaborator_compensation cp ON cp.collaborator_id = mc.id
           AND cp.starts_on < ($2::date + interval '1 month')
         LEFT JOIN network.matriz_collaborator_commission_rules cr ON cr.collaborator_id = mc.id
           AND cr.starts_on < ($2::date + interval '1 month')
        WHERE mc.environment = $1
        ORDER BY (mc.revoked_at IS NULL) DESC, mc.display_name`, [environment, competence]),
    db.query<any>(
      `WITH retail AS (
         SELECT o.seller_collaborator_id AS id, count(*)::int AS sales_count,
                COALESCE(sum(o.total_amount),0) AS revenue,
                COALESCE(sum(items.margin),0) AS margin
           FROM commerce.orders o
           JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
           LEFT JOIN LATERAL (
             SELECT COALESCE(sum((oi.unit_price-COALESCE(oi.matriz_unit_cost,oi.unit_price))*oi.quantity-oi.discount_amount),0) AS margin
               FROM commerce.order_items oi WHERE oi.order_id=o.id AND oi.environment=o.environment
           ) items ON true
          WHERE o.environment=$1 AND o.seller_collaborator_id IS NOT NULL
            AND o.status <> 'cancelled'
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
          GROUP BY o.seller_collaborator_id
       ), wholesale AS (
         SELECT o.seller_collaborator_id AS id, count(*)::int AS sales_count,
                COALESCE(sum(o.total_amount),0) AS revenue,
                COALESCE(sum(items.margin),0) AS margin
           FROM commerce.wholesale_orders o
           LEFT JOIN LATERAL (
             SELECT COALESCE(sum((oi.unit_price-oi.unit_cost)*oi.quantity),0) AS margin
               FROM commerce.wholesale_order_items oi WHERE oi.order_id=o.id AND oi.environment=o.environment
           ) items ON true
          WHERE o.environment=$1 AND o.seller_collaborator_id IS NOT NULL AND o.status='confirmed'
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
          GROUP BY o.seller_collaborator_id
       ), sales AS (
         SELECT id, sum(sales_count)::int sales_count, sum(revenue) revenue, sum(margin) margin
           FROM (SELECT * FROM retail UNION ALL SELECT * FROM wholesale) s GROUP BY id
       ), trip_stats AS (
         SELECT t.courier_collaborator_id AS id, count(*)::int AS trips_count,
                COALESCE(sum(GREATEST(COALESCE(t.km_end,t.km_start)-t.km_start,0)),0) AS distance_km
           FROM commerce.matriz_delivery_trips t
          WHERE t.environment=$1 AND t.courier_collaborator_id IS NOT NULL AND t.deleted_at IS NULL
            AND (t.started_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND (t.started_at AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
          GROUP BY t.courier_collaborator_id
       ), delivery_stats AS (
         SELECT t.courier_collaborator_id AS id,
                count(o.id) FILTER (WHERE o.delivery_status='delivered')::int AS deliveries_count,
                CASE WHEN count(o.id) FILTER (WHERE o.delivery_status='delivered')=0 THEN NULL ELSE
                  round(100.0*count(o.id) FILTER (WHERE o.delivery_status='delivered' AND o.delivered_at::date <= COALESCE(o.scheduled_delivery_date,o.delivered_at::date))
                    / count(o.id) FILTER (WHERE o.delivery_status='delivered'),1) END AS on_time_pct
           FROM commerce.matriz_delivery_trips t
           JOIN commerce.orders o ON o.delivery_trip_id=t.id AND o.environment=t.environment
          WHERE t.environment=$1 AND t.courier_collaborator_id IS NOT NULL AND t.deleted_at IS NULL
            AND (t.started_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
            AND (t.started_at AT TIME ZONE 'America/Sao_Paulo') < ($2::date + interval '1 month')
          GROUP BY t.courier_collaborator_id
       ), deliveries AS (
         SELECT COALESCE(t.id,d.id) id, COALESCE(d.deliveries_count,0) deliveries_count,
                COALESCE(t.trips_count,0) trips_count, COALESCE(t.distance_km,0) distance_km, d.on_time_pct
           FROM trip_stats t FULL JOIN delivery_stats d ON d.id=t.id
       )
       SELECT COALESCE(s.id,d.id) id, COALESCE(s.sales_count,0) sales_count,
              COALESCE(s.revenue,0) revenue, COALESCE(s.margin,0) margin,
              COALESCE(d.deliveries_count,0) deliveries_count, COALESCE(d.trips_count,0) trips_count,
              COALESCE(d.distance_km,0) distance_km, d.on_time_pct
         FROM sales s FULL JOIN deliveries d ON d.id=s.id`, [environment, competence]),
    db.query<any>(
      `SELECT collaborator_id,
              COALESCE(sum(amount) FILTER (WHERE kind='addition'),0) additions,
              COALESCE(sum(amount) FILTER (WHERE kind='deduction'),0) deductions
         FROM finance.matriz_payroll_adjustments
        WHERE environment=$1 AND competence=$2::date AND deleted_at IS NULL GROUP BY collaborator_id`,
      [environment, competence]),
    db.query<any>(
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
      ...p, base_salary: n(p.base_salary), payment_day: p.payment_day === null ? null : n(p.payment_day),
      commission_value: n(p.commission_value), commission_active: Boolean(p.commission_active),
      sales_count: n(q.sales_count), revenue: n(q.revenue), margin: n(q.margin),
      deliveries_count: n(q.deliveries_count), trips_count: n(q.trips_count), distance_km: n(q.distance_km),
      on_time_pct: q.on_time_pct === null || q.on_time_pct === undefined ? null : n(q.on_time_pct),
      additions: n(a.additions), deductions: n(a.deductions), commission_amount: 0, total_due: 0,
      payroll_item_id: f?.payroll_item_id ?? null, payroll_status: f?.payroll_status ?? 'preview',
      payroll_due_date: f?.payroll_due_date ?? null, payroll_paid_at: f?.payroll_paid_at ?? null,
      source_expense_id: f?.source_expense_id ?? null,
    };
    row.commission_amount = f ? n(f.commission_amount) : commissionFor(row);
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
