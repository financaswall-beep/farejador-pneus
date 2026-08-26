import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { TireCondition } from '../../shared/tire-condition.js';

export interface WholesaleStockRow {
  measure: string;
  brand: string;
  tire_condition: TireCondition;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  in_transit_quantity?: number;
  unit_cost: number;
  sales_30d?: number;
  min_quantity: number | null;
  replenishment_quantity_available?: number;
  notes: string | null;
  updated_at: string;
  tire_width_mm: number | null;
  tire_aspect_ratio: number | null;
  tire_rim_diameter: number | null;
}

/** Lista o estoque e informa, sem alterar saldos, o que já está em trânsito. */
export async function listWholesaleStock(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleStockRow[]> {
  const result = await dbPool.query<WholesaleStockRow>(
    `WITH sales_30d AS (
       SELECT environment,measure,brand,tire_condition,
              GREATEST(0,-COALESCE(sum(qty_delta),0))::int AS units
         FROM commerce.wholesale_stock_movements
        WHERE source IN (
          'venda_atacado','varejo','cancelamento_venda','cancelamento_varejo'
        )
          AND created_at>=now()-INTERVAL '30 days'
        GROUP BY environment,measure,brand,tire_condition
     ), stock_by_measure AS (
       SELECT environment,measure,tire_condition,
              sum(quantity_on_hand-quantity_reserved)::int AS units
         FROM commerce.wholesale_stock
        GROUP BY environment,measure,tire_condition
     ), pending_receipts AS (
       SELECT i.environment,i.measure,COALESCE(i.brand,'Sem marca') brand,i.tire_condition,
              COALESCE(sum(GREATEST(i.quantity-COALESCE(i.accepted_quantity,0),0)),0)::int units
         FROM commerce.wholesale_purchase_items i
         JOIN commerce.wholesale_purchases p
           ON p.environment=i.environment AND p.id=i.purchase_id
        WHERE p.status='pending'
        GROUP BY i.environment,i.measure,COALESCE(i.brand,'Sem marca'),i.tire_condition
     )
     SELECT ws.measure,ws.brand,ws.tire_condition,ws.quantity_on_hand,
            ws.quantity_reserved,
            (ws.quantity_on_hand-ws.quantity_reserved)::int AS quantity_available,
            COALESCE(pr.units,0)::int AS in_transit_quantity,
            ws.unit_cost,COALESCE(s.units,0)::int AS sales_30d,
            COALESCE(rp.min_quantity,ws.min_quantity) AS min_quantity,
            COALESCE(sm.units,0)::int AS replenishment_quantity_available,ws.notes,
            ws.updated_at,ws.tire_width_mm,ws.tire_aspect_ratio,ws.tire_rim_diameter
       FROM commerce.wholesale_stock ws
       LEFT JOIN sales_30d s
         ON s.environment=ws.environment AND s.measure=ws.measure
        AND s.brand=ws.brand AND s.tire_condition=ws.tire_condition
       LEFT JOIN pending_receipts pr
         ON pr.environment=ws.environment AND pr.measure=ws.measure
        AND pr.brand=ws.brand AND pr.tire_condition=ws.tire_condition
       LEFT JOIN stock_by_measure sm
         ON sm.environment=ws.environment AND sm.measure=ws.measure
        AND sm.tire_condition=ws.tire_condition
       LEFT JOIN commerce.wholesale_replenishment_policies rp
         ON rp.environment=ws.environment AND rp.measure=ws.measure
        AND rp.tire_condition=ws.tire_condition
      WHERE ws.environment=$1
      ORDER BY ws.measure,ws.brand,ws.tire_condition`,
    [environment],
  );
  return result.rows;
}
