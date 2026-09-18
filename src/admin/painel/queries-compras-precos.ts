import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { PurchaseReportPeriod } from './queries-compras-relatorios.js';
import { periodClause } from './purchase-period-clause.js';

interface WholesalePriceHistoryRow {
  purchase_id: string;
  purchased_at: string;
  supplier_id: string;
  supplier_name: string;
  measure: string;
  brand: string;
  tire_condition: string;
  vehicle_type?: string | null;
  quantity: number;
  unit_cost: string;
}

interface WholesalePriceAggregateRow {
  supplier_id: string;
  measure: string;
  brand: string;
  tire_condition: string;
  [key: string]: unknown;
}

export async function getWholesalePriceReport(
  input: { period: PurchaseReportPeriod; supplierId?: string; search?: string; from?: string; to?: string },
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const params: unknown[] = [environment];
  const where = [`p.environment=$1`, `p.status='confirmed'`, `COALESCE(i.accepted_quantity,i.quantity)>0`];
  if (input.from && input.to) {
    params.push(input.from, input.to);
    where.push(`p.purchased_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND p.purchased_at < (($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`);
  } else {
    const period = periodClause(input.period, 'p.purchased_at');
    if (period) where.push(period);
  }
  if (input.supplierId) {
    params.push(input.supplierId);
    where.push(`s.id=$${params.length}`);
  }
  const search = input.search?.trim().toLowerCase();
  if (search) {
    params.push(`%${search}%`);
    where.push(`(lower(i.measure) LIKE $${params.length}
      OR lower(i.brand) LIKE $${params.length})`);
  }
  const result = await dbPool.query<WholesalePriceAggregateRow>(
    `SELECT s.id AS supplier_id,s.name AS supplier_name,
            s.deleted_at IS NOT NULL AS supplier_archived,i.measure,i.brand,i.vehicle_type,
            i.tire_condition,
            sum(COALESCE(i.accepted_quantity,i.quantity))::int AS qty_total,
            round(sum(COALESCE(i.accepted_quantity,i.quantity)*i.unit_cost)
              /NULLIF(sum(COALESCE(i.accepted_quantity,i.quantity)),0),2) AS avg_cost,
            max(p.purchased_at) AS last_purchased_at,
            max(p.stock_applied_at) AS last_received_at,
            count(DISTINCT p.id)::int AS purchases_count
       FROM commerce.wholesale_purchase_items i
       JOIN commerce.wholesale_purchases p
         ON p.id=i.purchase_id AND p.environment=i.environment
       JOIN commerce.wholesale_suppliers s
         ON s.id=p.supplier_id AND s.environment=p.environment
      WHERE ${where.join(' AND ')}
      GROUP BY s.id,i.measure,i.brand,i.tire_condition,i.vehicle_type
      ORDER BY i.measure,i.brand,i.tire_condition,avg_cost,qty_total DESC
      LIMIT 1001`,
    params,
  );
  const history = await dbPool.query<WholesalePriceHistoryRow>(
    `SELECT p.id AS purchase_id,p.purchased_at,p.stock_applied_at AS received_at,
            s.id AS supplier_id,s.name AS supplier_name,
            i.measure,i.brand,i.tire_condition,i.vehicle_type,
            sum(COALESCE(i.accepted_quantity,i.quantity))::int AS quantity,
            round(sum(COALESCE(i.accepted_quantity,i.quantity)*i.unit_cost)
              /NULLIF(sum(COALESCE(i.accepted_quantity,i.quantity)),0),2) AS unit_cost
       FROM commerce.wholesale_purchase_items i
       JOIN commerce.wholesale_purchases p
         ON p.id=i.purchase_id AND p.environment=i.environment
       JOIN commerce.wholesale_suppliers s
         ON s.id=p.supplier_id AND s.environment=p.environment
      WHERE ${where.join(' AND ')}
      GROUP BY p.id,p.purchased_at,s.id,s.name,i.measure,i.brand,i.tire_condition,i.vehicle_type
      ORDER BY p.purchased_at DESC,p.id
      LIMIT 5001`,
    params,
  );
  const key = (row: Pick<WholesalePriceHistoryRow,
    'supplier_id' | 'measure' | 'brand' | 'tire_condition' | 'vehicle_type'>) =>
    [row.supplier_id, row.measure, row.brand, row.tire_condition, row.vehicle_type ?? ''].join('\u0000');
  const historyByVariant = new Map<string, WholesalePriceHistoryRow[]>();
  for (const row of history.rows.slice(0, 5000)) {
    const rowKey = key(row);
    if (!historyByVariant.has(rowKey)) historyByVariant.set(rowKey, []);
    historyByVariant.get(rowKey)!.push(row);
  }
  return result.rows.slice(0, 1000).map((row) => ({
    ...row,
    comparison_truncated: result.rows.length > 1000,
    history_truncated: history.rows.length > 5000,
    history: historyByVariant.get(key(row)) || [],
  }));
}
