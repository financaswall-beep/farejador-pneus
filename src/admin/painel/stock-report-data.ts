import type { Pool } from 'pg';
import { StockReportLimitError, type StockReportFilter } from './stock-report-filter.js';

export interface StockReportVariant {
  measure: string; brand: string; condition: string; physical: number; reserved: number; incoming: number;
  minimum: number | null; has_stock: boolean;
}
export interface StockReportMovement {
  id: string; measure: string; brand: string; condition: string; at: string;
  before: number; after: number; delta: number; source: string;
}
export interface StockReportSnapshot {
  as_of: string; from: string; to: string; variants: StockReportVariant[]; movements: StockReportMovement[];
}
/** One read-only snapshot: quantities, incoming purchases and the physical movement trail agree. */
export async function readStockReportSnapshot(db: Pool, environment: string, filter: StockReportFilter): Promise<StockReportSnapshot> {
  const client=await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='15s'");
    const clock=await client.query<{as_of:Date;from:string;to:string}>(`SELECT now() as_of,
      ((now() AT TIME ZONE 'America/Sao_Paulo')::date-($1::int-1))::text AS "from",
      (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS "to"`,[filter.days]);
    const instant=clock.rows[0]!;
    const stocks=await client.query<StockReportVariant>(`WITH pending AS (
      SELECT i.measure,COALESCE(i.brand,'Sem marca') brand,i.tire_condition,
        sum(GREATEST(i.quantity-COALESCE(i.accepted_quantity,0),0))::int incoming
      FROM commerce.wholesale_purchase_items i JOIN commerce.wholesale_purchases p
        ON p.environment=i.environment AND p.id=i.purchase_id
      WHERE i.environment=$1 AND p.status='pending' GROUP BY i.measure,COALESCE(i.brand,'Sem marca'),i.tire_condition
    ), identities AS (
      SELECT measure,brand,tire_condition FROM commerce.wholesale_stock WHERE environment=$1
      UNION SELECT measure,brand,tire_condition FROM pending
      UNION SELECT rp.measure,'Sem marca',rp.tire_condition FROM commerce.wholesale_replenishment_policies rp
        WHERE rp.environment=$1 AND NOT EXISTS (SELECT 1 FROM commerce.wholesale_stock s
          WHERE s.environment=rp.environment AND s.measure=rp.measure AND s.tire_condition=rp.tire_condition)
          AND NOT EXISTS(SELECT 1 FROM pending p WHERE p.measure=rp.measure AND p.tire_condition=rp.tire_condition)
    ) SELECT k.measure,k.brand,k.tire_condition AS "condition",COALESCE(s.quantity_on_hand,0)::int physical,
      COALESCE(s.quantity_reserved,0)::int reserved,COALESCE(p.incoming,0)::int incoming,
      COALESCE(rp.min_quantity,s.min_quantity)::int minimum,(s.id IS NOT NULL) has_stock
    FROM identities k LEFT JOIN commerce.wholesale_stock s ON s.environment=$1
      AND s.measure=k.measure AND s.brand=k.brand AND s.tire_condition=k.tire_condition
    LEFT JOIN pending p ON p.measure=k.measure AND p.brand=k.brand AND p.tire_condition=k.tire_condition
    LEFT JOIN commerce.wholesale_replenishment_policies rp ON rp.environment=$1
      AND rp.measure=k.measure AND rp.tire_condition=k.tire_condition
    ORDER BY k.measure,k.tire_condition,k.brand LIMIT 20001`,[environment]);
    if(stocks.rows.length>20000)throw new StockReportLimitError('stock_report_variant_limit');
    const events=await client.query<Omit<StockReportMovement,'at'> & {at:Date}>(`SELECT id,measure,brand,tire_condition AS "condition",
      created_at AS at,qty_before AS "before",qty_after AS "after",qty_delta AS delta,source
      FROM commerce.wholesale_stock_movements WHERE environment=$1
        AND created_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND created_at<=now()
      ORDER BY created_at DESC,id DESC LIMIT 50001`,[environment,instant.from]);
    if(events.rows.length>50000)throw new StockReportLimitError('stock_report_movement_limit');
    await client.query('COMMIT');
    return {as_of:instant.as_of.toISOString(),from:instant.from,to:instant.to,variants:stocks.rows,
      movements:events.rows.map(row=>({...row,at:row.at.toISOString()}))};
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
}
