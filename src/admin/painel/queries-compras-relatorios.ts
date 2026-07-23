import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export type PurchaseReportPeriod = '30d' | '90d' | 'year' | 'all';
export type PurchaseReportStatus = 'all' | 'pending' | 'confirmed' | 'cancelled';
export type PurchaseReportPayment = 'all' | 'paid' | 'pending';

export interface PurchaseReportFilters {
  period: PurchaseReportPeriod;
  status: PurchaseReportStatus;
  payment: PurchaseReportPayment;
  search?: string;
  page: number;
  pageSize: number;
}

interface PurchaseReportSummary {
  rows_count: number;
  purchases_count: number;
  received_tires: number;
  total_committed: string;
  pending_receipts: number;
  open_payments: number;
}

export interface PurchaseReport {
  rows: unknown[];
  summary: PurchaseReportSummary;
  pagination: { page: number; page_size: number; total: number; pages: number };
}

function periodClause(period: PurchaseReportPeriod, column: string): string | null {
  const local = `(${column} AT TIME ZONE 'America/Sao_Paulo')`;
  if (period === '30d') return `${local} >= (now() AT TIME ZONE 'America/Sao_Paulo') - interval '30 days'`;
  if (period === '90d') return `${local} >= (now() AT TIME ZONE 'America/Sao_Paulo') - interval '90 days'`;
  if (period === 'year') {
    return `${local} >= date_trunc('year', now() AT TIME ZONE 'America/Sao_Paulo')`;
  }
  return null;
}

function purchaseWhere(
  environment: 'prod' | 'test',
  filters: PurchaseReportFilters,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [environment];
  const where = ['p.environment=$1'];
  const period = periodClause(filters.period, 'p.purchased_at');
  if (period) where.push(period);
  if (filters.status !== 'all') {
    params.push(filters.status);
    where.push(`p.status=$${params.length}`);
  }
  if (filters.payment !== 'all') {
    params.push(filters.payment);
    where.push(`p.payment_status=$${params.length}`);
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

export async function getWholesalePurchaseReport(
  filters: PurchaseReportFilters,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<PurchaseReport> {
  const query = purchaseWhere(environment, filters);
  const summary = await dbPool.query<PurchaseReportSummary>(
    `WITH filtered AS (
       SELECT p.id,p.status,p.payment_status,p.total_amount,
              COALESCE((SELECT sum(i.quantity) FROM commerce.wholesale_purchase_items i
                WHERE i.environment=p.environment AND i.purchase_id=p.id),0)::int AS tires
         FROM commerce.wholesale_purchases p
         JOIN commerce.wholesale_suppliers s
           ON s.id=p.supplier_id AND s.environment=p.environment
        WHERE ${query.sql}
     )
     SELECT count(*)::int AS rows_count,
            count(*) FILTER (WHERE status<>'cancelled')::int AS purchases_count,
            COALESCE(sum(tires) FILTER (WHERE status='confirmed'),0)::int AS received_tires,
            COALESCE(sum(total_amount) FILTER (WHERE status<>'cancelled'),0)::text AS total_committed,
            count(*) FILTER (WHERE status='pending')::int AS pending_receipts,
            count(*) FILTER (WHERE status<>'cancelled' AND payment_status='pending')::int AS open_payments
       FROM filtered`,
    query.params,
  );
  const offset = (filters.page - 1) * filters.pageSize;
  const rowParams = [...query.params, filters.pageSize, offset];
  const rows = await dbPool.query(
    `SELECT p.id,p.supplier_id,s.name AS supplier_name,s.deleted_at AS supplier_archived_at,
            p.purchased_at,p.total_amount,p.payment_status,p.due_date,p.paid_at,
            p.status,p.stock_applied,p.stock_applied_at,p.created_by,p.notes,
            p.cancelled_at,p.cancelled_by,p.cancel_reason,
            COALESCE(sum(i.quantity),0)::int AS items_count,
            COALESCE(jsonb_agg(jsonb_build_object(
              'id',i.id,'measure',i.measure,'brand',i.brand,'quantity',i.quantity,
              'unit_cost',i.unit_cost,'line_total',i.line_total
            ) ORDER BY i.measure,i.id) FILTER (WHERE i.id IS NOT NULL),'[]'::jsonb) AS items
       FROM commerce.wholesale_purchases p
       JOIN commerce.wholesale_suppliers s
         ON s.id=p.supplier_id AND s.environment=p.environment
       LEFT JOIN commerce.wholesale_purchase_items i
         ON i.purchase_id=p.id AND i.environment=p.environment
      WHERE ${query.sql}
      GROUP BY p.id,s.id
      ORDER BY p.purchased_at DESC,p.id DESC
      LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
    rowParams,
  );
  const totals = summary.rows[0] ?? {
    rows_count: 0, purchases_count: 0, received_tires: 0, total_committed: '0',
    pending_receipts: 0, open_payments: 0,
  };
  return {
    rows: rows.rows,
    summary: totals,
    pagination: {
      page: filters.page,
      page_size: filters.pageSize,
      total: totals.rows_count,
      pages: Math.max(1, Math.ceil(totals.rows_count / filters.pageSize)),
    },
  };
}

export async function getWholesaleSupplierInsights(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT s.id AS supplier_id,s.name,s.phone,s.document,s.notes,
            count(p.id) FILTER (WHERE p.status<>'cancelled')::int AS purchases_count,
            COALESCE(sum(p.total_amount) FILTER (WHERE p.status<>'cancelled'),0) AS total_spent,
            max(p.purchased_at) FILTER (WHERE p.status<>'cancelled') AS last_purchase_at,
            current_date-(max(p.purchased_at)
              FILTER (WHERE p.status<>'cancelled'))::date AS days_since_last,
            count(p.id) FILTER (WHERE p.status='pending')::int AS pending_receipts,
            count(p.id) FILTER (WHERE p.status<>'cancelled'
              AND p.payment_status='pending')::int AS open_payments,
            COALESCE((
              SELECT jsonb_agg(m ORDER BY m.qty_total DESC,m.measure)
                FROM (
                  SELECT i.measure,sum(i.quantity)::int AS qty_total
                    FROM commerce.wholesale_purchase_items i
                    JOIN commerce.wholesale_purchases cp
                      ON cp.id=i.purchase_id AND cp.environment=i.environment
                   WHERE i.environment=s.environment AND cp.supplier_id=s.id
                     AND cp.status='confirmed'
                   GROUP BY i.measure
                ) m
            ),'[]'::jsonb) AS measures
       FROM commerce.wholesale_suppliers s
       LEFT JOIN commerce.wholesale_purchases p
         ON p.supplier_id=s.id AND p.environment=s.environment
      WHERE s.environment=$1 AND s.deleted_at IS NULL
      GROUP BY s.id
      ORDER BY total_spent DESC,last_purchase_at DESC NULLS LAST,s.name`,
    [environment],
  );
  return result.rows;
}

export async function getWholesalePriceReport(
  input: { period: PurchaseReportPeriod; supplierId?: string; search?: string },
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const params: unknown[] = [environment];
  const where = [`p.environment=$1`, `p.status='confirmed'`];
  const period = periodClause(input.period, 'p.purchased_at');
  if (period) where.push(period);
  if (input.supplierId) {
    params.push(input.supplierId);
    where.push(`s.id=$${params.length}`);
  }
  const search = input.search?.trim().toLowerCase();
  if (search) {
    params.push(`%${search}%`);
    where.push(`lower(i.measure) LIKE $${params.length}`);
  }
  const result = await dbPool.query(
    `SELECT s.id AS supplier_id,s.name AS supplier_name,
            s.deleted_at IS NOT NULL AS supplier_archived,i.measure,
            sum(i.quantity)::int AS qty_total,
            round(sum(i.line_total)/NULLIF(sum(i.quantity),0),2) AS avg_cost,
            max(p.purchased_at) AS last_purchased_at,
            count(DISTINCT p.id)::int AS purchases_count
       FROM commerce.wholesale_purchase_items i
       JOIN commerce.wholesale_purchases p
         ON p.id=i.purchase_id AND p.environment=i.environment
       JOIN commerce.wholesale_suppliers s
         ON s.id=p.supplier_id AND s.environment=p.environment
      WHERE ${where.join(' AND ')}
      GROUP BY s.id,i.measure
      ORDER BY i.measure,avg_cost,qty_total DESC
      LIMIT 1000`,
    params,
  );
  return result.rows;
}
