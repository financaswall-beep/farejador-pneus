import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { PurchaseReportFilters, PurchaseReportPeriod } from './queries-compras-relatorios.js';

export interface PurchaseHistoryAnalytics {
  summary: {
    purchases_count: number; total_committed: string; paid_amount: string;
    open_amount: string; tires: number; received_tires: number;
    in_transit_tires: number; active_suppliers: number; average_cost: string;
    previous_average_cost: string | null; average_change_pct: string | null;
    minimum_item_cost: string | null; maximum_item_cost: string | null;
  };
  timeline: Array<{
    bucket: string; total_committed: string; tires: number;
    received_tires: number; average_cost: string;
  }>;
}

function periodClause(period: PurchaseReportPeriod, previous: boolean): string | null {
  const local = `(p.purchased_at AT TIME ZONE 'America/Sao_Paulo')`;
  const now = `(now() AT TIME ZONE 'America/Sao_Paulo')`;
  if (period === '30d') return previous
    ? `${local} >= ${now} - interval '60 days' AND ${local} < ${now} - interval '30 days'`
    : `${local} >= ${now} - interval '30 days'`;
  if (period === '90d') return previous
    ? `${local} >= ${now} - interval '180 days' AND ${local} < ${now} - interval '90 days'`
    : `${local} >= ${now} - interval '90 days'`;
  if (period === 'year') return previous
    ? `${local} >= date_trunc('year',${now}) - interval '1 year'
       AND ${local} < date_trunc('year',${now})`
    : `${local} >= date_trunc('year',${now})`;
  return null;
}

function analyticsWhere(environment: 'prod' | 'test', filters: PurchaseReportFilters,
  previous = false): { sql: string; params: unknown[] } {
  const params: unknown[] = [environment];
  const where = ['p.environment=$1'];
  const period = periodClause(filters.period, previous);
  if (period) where.push(period);
  if (filters.status !== 'all') {
    params.push(filters.status); where.push(`p.status=$${params.length}`);
  }
  if (filters.payment !== 'all') {
    params.push(filters.payment); where.push(`p.payment_status=$${params.length}`);
  }
  if (filters.supplierId) {
    params.push(filters.supplierId); where.push(`p.supplier_id=$${params.length}`);
  }
  const search = filters.search?.trim().toLowerCase();
  if (search) {
    params.push(`%${search}%`);
    where.push(`(lower(s.name) LIKE $${params.length}
      OR EXISTS (SELECT 1 FROM commerce.wholesale_purchase_items si
        WHERE si.environment=p.environment AND si.purchase_id=p.id
          AND lower(si.measure) LIKE $${params.length}))`);
  }
  return { sql: where.join(' AND '), params };
}

function timelineBucket(period: PurchaseReportPeriod): string {
  const local = `(p.purchased_at AT TIME ZONE 'America/Sao_Paulo')`;
  if (period === '30d') return `date_trunc('day',${local})`;
  if (period === '90d') return `date_trunc('week',${local})`;
  return `date_trunc('month',${local})`;
}

export async function getWholesalePurchaseAnalytics(
  filters: PurchaseReportFilters,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<PurchaseHistoryAnalytics> {
  const current = analyticsWhere(environment, filters);
  const summary = await dbPool.query<{
    purchases_count: number; total_committed: string; paid_amount: string;
    open_amount: string; tires: number; received_tires: number;
    in_transit_tires: number; active_suppliers: number; average_cost: string;
    minimum_item_cost: string | null; maximum_item_cost: string | null;
  }>(
    `WITH purchase_base AS (
       SELECT p.id,p.status,p.payment_status,p.supplier_id,p.total_amount,
              COALESCE(items.tires,0)::int tires,
              COALESCE(items.allocated,0)::numeric allocated,
              CASE WHEN p.status='cancelled' OR p.payment_status='paid' THEN 0::numeric
                   WHEN obligation.id IS NULL THEN p.total_amount
                   ELSE COALESCE(finance.matriz_ledger_obligation_balance(
                     p.environment,obligation.id),p.total_amount) END open_amount
         FROM commerce.wholesale_purchases p
         JOIN commerce.wholesale_suppliers s
           ON s.id=p.supplier_id AND s.environment=p.environment
         LEFT JOIN LATERAL (
           SELECT COALESCE(sum(COALESCE(i.accepted_quantity,i.quantity)),0) tires,
                  COALESCE(sum(i.allocated_cost),0) allocated
             FROM commerce.wholesale_purchase_items i
            WHERE i.environment=p.environment AND i.purchase_id=p.id
         ) items ON true
         LEFT JOIN finance.matriz_ledger_transactions obligation
           ON obligation.environment=p.environment
          AND obligation.source_type='commerce.wholesale_purchase.accrual'
          AND obligation.source_id=p.id::text
        WHERE ${current.sql}
     ), item_bounds AS (
       SELECT min(i.allocated_cost/NULLIF(COALESCE(i.accepted_quantity,i.quantity),0))
                FILTER (WHERE p.status<>'cancelled') minimum_item_cost,
              max(i.allocated_cost/NULLIF(COALESCE(i.accepted_quantity,i.quantity),0))
                FILTER (WHERE p.status<>'cancelled') maximum_item_cost
         FROM commerce.wholesale_purchases p
         JOIN commerce.wholesale_suppliers s
           ON s.id=p.supplier_id AND s.environment=p.environment
         JOIN commerce.wholesale_purchase_items i
           ON i.environment=p.environment AND i.purchase_id=p.id
        WHERE ${current.sql}
     )
     SELECT count(*) FILTER (WHERE status<>'cancelled')::int purchases_count,
            COALESCE(sum(total_amount) FILTER (WHERE status<>'cancelled'),0)::text total_committed,
            COALESCE(sum(total_amount-open_amount)
              FILTER (WHERE status<>'cancelled'),0)::text paid_amount,
            COALESCE(sum(open_amount) FILTER (WHERE status<>'cancelled'),0)::text open_amount,
            COALESCE(sum(tires) FILTER (WHERE status<>'cancelled'),0)::int tires,
            COALESCE(sum(tires) FILTER (WHERE status='confirmed'),0)::int received_tires,
            COALESCE(sum(tires) FILTER (WHERE status='pending'),0)::int in_transit_tires,
            count(DISTINCT supplier_id) FILTER (WHERE status<>'cancelled')::int active_suppliers,
            COALESCE(round(sum(allocated) FILTER (WHERE status<>'cancelled')
              /NULLIF(sum(tires) FILTER (WHERE status<>'cancelled'),0),2),0)::text average_cost,
            b.minimum_item_cost::text,b.maximum_item_cost::text
       FROM purchase_base CROSS JOIN item_bounds b
      GROUP BY b.minimum_item_cost,b.maximum_item_cost`, current.params);

  const timeline = await dbPool.query<PurchaseHistoryAnalytics['timeline'][number]>(
    `WITH purchase_bucket AS (
       SELECT ${timelineBucket(filters.period)} bucket,p.id,p.status,p.total_amount,
              COALESCE(sum(COALESCE(i.accepted_quantity,i.quantity)),0)::int tires,
              COALESCE(sum(i.allocated_cost),0)::numeric allocated
         FROM commerce.wholesale_purchases p
         JOIN commerce.wholesale_suppliers s
           ON s.id=p.supplier_id AND s.environment=p.environment
         LEFT JOIN commerce.wholesale_purchase_items i
           ON i.environment=p.environment AND i.purchase_id=p.id
        WHERE ${current.sql}
        GROUP BY bucket,p.id
     )
     SELECT bucket::date::text bucket,
            COALESCE(sum(total_amount) FILTER (WHERE status<>'cancelled'),0)::text total_committed,
            COALESCE(sum(tires) FILTER (WHERE status<>'cancelled'),0)::int tires,
            COALESCE(sum(tires) FILTER (WHERE status='confirmed'),0)::int received_tires,
            COALESCE(round(sum(allocated) FILTER (WHERE status<>'cancelled')
              /NULLIF(sum(tires) FILTER (WHERE status<>'cancelled'),0),2),0)::text average_cost
       FROM purchase_bucket GROUP BY bucket ORDER BY bucket LIMIT 180`, current.params);

  let previousAverage: string | null = null;
  if (filters.period !== 'all') {
    const previous = analyticsWhere(environment, filters, true);
    const result = await dbPool.query<{ average_cost: string | null }>(
      `SELECT round(sum(i.allocated_cost)
          /NULLIF(sum(COALESCE(i.accepted_quantity,i.quantity)),0),2)::text average_cost
         FROM commerce.wholesale_purchases p
         JOIN commerce.wholesale_suppliers s
           ON s.id=p.supplier_id AND s.environment=p.environment
         JOIN commerce.wholesale_purchase_items i
           ON i.environment=p.environment AND i.purchase_id=p.id
        WHERE ${previous.sql} AND p.status<>'cancelled'`, previous.params);
    previousAverage = result.rows[0]?.average_cost ?? null;
  }
  const row = summary.rows[0] ?? {
    purchases_count: 0, total_committed: '0', paid_amount: '0', open_amount: '0',
    tires: 0, received_tires: 0, in_transit_tires: 0, active_suppliers: 0,
    average_cost: '0', minimum_item_cost: null, maximum_item_cost: null,
  };
  const previousValue = Number(previousAverage || 0);
  const change = previousAverage && previousValue > 0
    ? (((Number(row.average_cost || 0) - previousValue) / previousValue) * 100).toFixed(1)
    : null;
  return { summary: { ...row, previous_average_cost: previousAverage,
    average_change_pct: change }, timeline: timeline.rows };
}
