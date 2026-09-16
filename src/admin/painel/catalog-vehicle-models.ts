import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { TireVehicleType } from '../../shared/tire-vehicle-type.js';

export interface CatalogVehicleModelRow {
  vehicle_model_id: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  displacement_cc: number | null;
}

export async function searchCatalogVehicleModels(
  term: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  vehicleType: TireVehicleType = 'motorcycle',
): Promise<CatalogVehicleModelRow[]> {
  const query = term.trim();
  if (query.length < 2) return [];
  const result = await dbPool.query<CatalogVehicleModelRow>(
    `SELECT id AS vehicle_model_id,vehicle_type,make,model,variant,year_start,year_end,displacement_cc
       FROM commerce.vehicle_models
      WHERE environment=$1 AND vehicle_type=$4 AND deleted_at IS NULL
        AND (make ILIKE $2 OR model ILIKE $2 OR COALESCE(variant,'') ILIKE $2
          OR COALESCE(aliases::text,'') ILIKE $2
          OR concat_ws(' ',make,model,variant,displacement_cc::text) ILIKE $2)
      ORDER BY
        CASE WHEN lower(model)=lower($3) THEN 0
             WHEN lower(model) LIKE lower($3) || '%' THEN 1 ELSE 2 END,
        make,model,variant NULLS FIRST,year_start NULLS FIRST
      LIMIT 30`,
    [environment, `%${query}%`, query, vehicleType],
  );
  return result.rows;
}
