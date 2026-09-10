import type { Pool } from 'pg';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { reportComparison } from './report-period.js';
import type { PurchaseReportFilter } from './purchase-report-period.js';

/** Monetary values are integer cents. No current stock or customer data is read. */
export interface PurchaseReportLine {
  id: string; purchase_id: string; order_code: string | null; day: string; received_on: string | null;
  supplier_id: string; supplier_name: string; status: 'pending' | 'confirmed';
  full_total: number; open: number; measure: string; brand: string; condition: string;
  quantity: number; ordered: number; received: number; transit: number; value: number; base_unit_cost: number;
}
export class PurchaseReportLimitError extends Error {}
export async function readPurchaseReportLines(db: Pool, environment: string, filter: PurchaseReportFilter): Promise<PurchaseReportLine[]> {
  const previous = reportComparison(filter);
  const result = await db.query<{
    id: string; purchase_id: string; order_code: string | null; day: string; received_on: string | null;
    supplier_id: string; supplier_name: string; status: 'pending' | 'confirmed';
    full_total: string; open: string; measure: string; brand: string | null; condition: string | null;
    quantity: number; ordered: number; value: string; base_unit_cost: string;
  }>(`WITH bounds AS (
    SELECT $2::date::timestamp AT TIME ZONE 'America/Sao_Paulo' start_at,
      ($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo' end_at,
      $4::date::timestamp AT TIME ZONE 'America/Sao_Paulo' previous_start,
      ($5::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo' previous_end
  ), purchases AS MATERIALIZED (
    SELECT p.id,p.environment,p.supplier_id,s.name supplier_name,p.status,p.total_amount,
      (p.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS "day",
      (p.stock_applied_at AT TIME ZONE 'America/Sao_Paulo')::date::text received_on,
      CASE WHEN o.id IS NOT NULL THEN 'OC-'||to_char(o.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY')
        ||'-'||lpad(o.order_number::text,6,'0') END order_code,
      CASE WHEN p.payment_status='paid' THEN 0::numeric
        WHEN obligation.id IS NULL THEN p.total_amount
        ELSE GREATEST(0,LEAST(p.total_amount,COALESCE(finance.matriz_ledger_obligation_balance(
          p.environment,obligation.id),p.total_amount))) END open_amount
    FROM commerce.wholesale_purchases p
    JOIN commerce.wholesale_suppliers s ON s.id=p.supplier_id AND s.environment=p.environment
    LEFT JOIN commerce.wholesale_purchase_orders o ON o.id=p.purchase_order_id AND o.environment=p.environment
    LEFT JOIN finance.matriz_ledger_transactions obligation ON obligation.environment=p.environment
      AND obligation.source_type='commerce.wholesale_purchase.accrual' AND obligation.source_id=p.id::text
    CROSS JOIN bounds b
    WHERE p.environment=$1 AND p.status IN ('pending','confirmed')
      AND ((p.purchased_at>=b.start_at AND p.purchased_at<b.end_at)
        OR (p.purchased_at>=b.previous_start AND p.purchased_at<b.previous_end))
  ) SELECT i.id,p.id purchase_id,p.order_code,p."day",p.received_on,p.supplier_id,p.supplier_name,p.status,
      p.total_amount::text full_total,p.open_amount::text open,
      i.measure,i.brand,i.tire_condition AS "condition",
      COALESCE(i.accepted_quantity,i.quantity)::int quantity,i.ordered_quantity::int ordered,
      i.allocated_cost::text value,i.unit_cost::text base_unit_cost
    FROM purchases p JOIN commerce.wholesale_purchase_items i ON i.purchase_id=p.id AND i.environment=p.environment
    ORDER BY p."day" DESC,p.id,i.id LIMIT 50001`,
  [environment, filter.from, filter.to, previous?.from ?? null, previous?.to ?? null]);
  if (result.rows.length > 50000) throw new PurchaseReportLimitError('report_limit_reduce_period');
  const cents = (value: string) => Math.round(Number(value) * 100);
  return result.rows.map(row => ({ ...row, measure: row.measure.trim().toUpperCase(),
    brand: canonicalCatalogBrand(row.brand) || 'Sem marca', condition: row.condition || 'unknown',
    quantity: Number(row.quantity), ordered: Number(row.ordered), value: cents(row.value), base_unit_cost: cents(row.base_unit_cost),
    full_total: cents(row.full_total), open: cents(row.open),
    received: row.status === 'confirmed' ? Number(row.quantity) : 0,
    transit: row.status === 'pending' ? Number(row.quantity) : 0,
  }));
}
