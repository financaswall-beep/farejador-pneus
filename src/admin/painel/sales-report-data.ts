import type { Pool } from 'pg';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { salesReportComparison, type SalesReportFilter } from './sales-report-period.js';

export interface ReportLine {
  id: string; sale_id: string; channel: 'varejo' | 'atacado'; day: string;
  measure: string; brand: string; condition: string; kind: string;
  quantity: number; revenue: number; cost: number | null;
}
export class SalesReportLimitError extends Error {}

/** Commercial dates follow Vendas: retail created_at and wholesale sold_at.
 * Only accepted quantities of settled partner transfers belong to the Matriz.
 * Costs/prices/conditions come from the sale; stock prices are never consulted.
 * Retail brand and technical identity use the referenced catalog (no historical snapshot exists).
 */
export async function readSalesReportLines(db: Pool, environment: string, filter: SalesReportFilter): Promise<ReportLine[]> {
  const previous = salesReportComparison(filter);
  const result = await db.query<{
    id: string; sale_id: string; channel: 'varejo' | 'atacado'; day: string;
    measure: string; brand: string | null; condition: string | null; kind: string;
    quantity: number; revenue: string; cost: string | null;
  }>(`WITH bounds AS (
    SELECT $2::date::timestamp AT TIME ZONE 'America/Sao_Paulo' start_at,
      ($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo' end_at,
      $4::date::timestamp AT TIME ZONE 'America/Sao_Paulo' previous_start,
      ($5::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo' previous_end
  ), lines AS (
    SELECT i.id,o.id sale_id,'varejo'::text channel,
      (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS "day",
      COALESCE(NULLIF(btrim(ts.tire_size),''),p.product_name,'Item sem identificação') measure,
      p.brand,i.tire_condition AS "condition",p.product_type::text kind,i.quantity,
      (i.quantity*i.unit_price-i.discount_amount)::text revenue,
      round(i.quantity*i.matriz_unit_cost,2)::text cost
    FROM commerce.orders o
    JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
    JOIN commerce.order_items i ON i.order_id=o.id AND i.environment=o.environment
    JOIN commerce.products p ON p.id=i.product_id AND p.environment=i.environment
    LEFT JOIN commerce.tire_specs ts ON ts.product_id=p.id AND ts.environment=p.environment
    CROSS JOIN bounds b
    WHERE o.environment=$1 AND o.partner_order_id IS NULL
      AND o.status IN ('confirmed','paid','delivered')
      AND ($6='all' OR $6='varejo')
      AND ((o.created_at>=b.start_at AND o.created_at<b.end_at)
        OR (o.created_at>=b.previous_start AND o.created_at<b.previous_end))
    UNION ALL
    SELECT i.id,o.id,'atacado',
      (o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date::text,
      i.measure,i.brand,i.tire_condition,'tire',q.quantity,
      (q.quantity*i.unit_price)::text,round(q.quantity*i.unit_cost,2)::text
    FROM commerce.wholesale_orders o
    JOIN commerce.wholesale_order_items i ON i.order_id=o.id AND i.environment=o.environment
    CROSS JOIN LATERAL (SELECT CASE WHEN o.partner_transfer_status IN ('settled','received')
      THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END quantity) q
    CROSS JOIN bounds b
    WHERE o.environment=$1 AND o.status='confirmed' AND q.quantity>0
      AND (o.partner_transfer_status IS NULL OR o.partner_transfer_status IN ('settled','received'))
      AND ($6='all' OR $6='atacado')
      AND ((o.sold_at>=b.start_at AND o.sold_at<b.end_at)
        OR (o.sold_at>=b.previous_start AND o.sold_at<b.previous_end))
  ) SELECT * FROM lines ORDER BY "day" DESC,sale_id,id LIMIT 50001`,
  [environment, filter.from, filter.to, previous?.from ?? null, previous?.to ?? null, filter.channel]);
  if (result.rows.length > 50000) throw new SalesReportLimitError('report_limit_reduce_period');
  return result.rows.map(row => ({ ...row,
    measure: row.kind === 'tire' ? row.measure.trim().toUpperCase() : row.measure.trim(),
    brand: canonicalCatalogBrand(row.brand) || 'Sem marca', condition: row.condition || 'unknown',
    quantity: Number(row.quantity), revenue: Math.round(Number(row.revenue) * 100),
    cost: row.cost === null ? null : Math.round(Number(row.cost) * 100),
  }));
}
