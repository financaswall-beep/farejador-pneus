import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { TireCondition } from '../../shared/tire-condition.js';

export interface WholesaleMeasureRow {
  measure: string;
  brand: string | null;
  tire_condition: TireCondition | null;
  quantity_on_hand: number | null;
  unit_cost: number | null;
}

export async function listWholesaleMeasures(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleMeasureRow[]> {
  const result = await dbPool.query<WholesaleMeasureRow>(
    `SELECT m.measure,m.brand,m.tire_condition,ws.quantity_on_hand,ws.unit_cost
       FROM (
         SELECT DISTINCT ts.tire_size measure,p.brand,p.tire_condition
           FROM commerce.tire_specs ts
           JOIN commerce.products p
             ON p.id=ts.product_id AND p.environment=ts.environment
          WHERE ts.environment=$1 AND ts.tire_size IS NOT NULL
            AND p.deleted_at IS NULL AND p.product_type='tire'
         UNION
         SELECT measure,brand,tire_condition
           FROM commerce.wholesale_stock WHERE environment=$1
       ) m
       LEFT JOIN commerce.wholesale_stock ws
         ON ws.environment=$1 AND ws.measure=m.measure
        AND lower(ws.brand)=lower(COALESCE(m.brand,'Sem marca'))
        AND ws.tire_condition=m.tire_condition
      ORDER BY m.measure,m.brand NULLS LAST,m.tire_condition`,
    [environment],
  );
  return result.rows;
}
