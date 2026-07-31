import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { TireCondition } from '../../shared/tire-condition.js';

export interface GalpaoMovementRow {
  measure: string;
  brand: string;
  tire_condition: TireCondition;
  op: 'insert' | 'update' | 'delete';
  qty_before: number;
  qty_after: number;
  qty_delta: number;
  cost_before: string | null;
  cost_after: string | null;
  source: string;
  reason: string | null;
  ref: string | null;
  created_at: string;
}

export async function listGalpaoMovements(
  opts: {
    measure?: string | null;
    brand?: string | null;
    tire_condition?: TireCondition | null;
    limit?: number;
    environment?: 'prod' | 'test';
  } = {},
  dbPool: Pool = defaultPool,
): Promise<GalpaoMovementRow[]> {
  const environment = opts.environment ?? env.FAREJADOR_ENV;
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const measure = opts.measure?.trim() || null;
  const brand = opts.brand?.trim() || null;
  const tireCondition = opts.tire_condition ?? null;
  const result = await dbPool.query<GalpaoMovementRow>(
    `SELECT measure,brand,tire_condition,op,qty_before,qty_after,qty_delta,
            cost_before,cost_after,source,reason,ref,created_at
       FROM commerce.wholesale_stock_movements
      WHERE environment=$1 AND ($2::text IS NULL OR measure=$2)
        AND ($3::text IS NULL OR brand=$3)
        AND ($4::text IS NULL OR tire_condition=$4)
      ORDER BY created_at DESC,id DESC
      LIMIT $5`,
    [environment, measure, brand, tireCondition, limit],
  );
  return result.rows;
}
