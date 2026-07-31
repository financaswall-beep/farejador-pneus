import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { TireCondition } from '../../shared/tire-condition.js';

export interface CatalogCompatibilityRow {
  vehicle_model_id: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  position: 'front' | 'rear' | 'both';
  is_oem: boolean;
  source: 'manufacturer' | 'manual' | 'discovery_promoted';
  confidence_level: string | null;
}

export async function getCatalogCompatibility(
  productId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{
  product: {
    product_id: string;
    product_code: string;
    product_name: string;
    brand: string | null;
    tire_condition: TireCondition | null;
    tire_size: string | null;
  };
  summary: { models: number; fitments: number };
  rows: CatalogCompatibilityRow[];
}> {
  const product = await dbPool.query<{
    product_id: string;
    product_code: string;
    product_name: string;
    brand: string | null;
    tire_condition: TireCondition | null;
    tire_size: string | null;
  }>(
    `SELECT p.id AS product_id,p.product_code,p.product_name,p.brand,p.tire_condition,
            ts.tire_size
       FROM commerce.products p
       LEFT JOIN commerce.tire_specs ts
         ON ts.product_id=p.id AND ts.environment=p.environment
      WHERE p.environment=$1 AND p.id=$2
        AND p.product_type='tire' AND p.deleted_at IS NULL
      LIMIT 1`,
    [environment, productId],
  );
  const selected = product.rows[0];
  if (!selected) throw new Error('catalog_product_not_found');

  const fitments = await dbPool.query<CatalogCompatibilityRow>(
    `SELECT vm.id AS vehicle_model_id,vm.make,vm.model,vm.variant,
            vm.year_start,vm.year_end,vf.position,vf.is_oem,vf.source,
            vf.confidence_level
       FROM commerce.products p
       JOIN commerce.tire_specs ts
         ON ts.product_id=p.id AND ts.environment=p.environment
       JOIN commerce.vehicle_fitments vf
         ON vf.tire_spec_id=ts.id AND vf.environment=ts.environment
       JOIN commerce.vehicle_models vm
         ON vm.id=vf.vehicle_model_id AND vm.environment=vf.environment
      WHERE p.environment=$1 AND p.id=$2
        AND p.deleted_at IS NULL AND vm.deleted_at IS NULL
      ORDER BY vm.make,vm.model,vm.variant NULLS FIRST,vf.position`,
    [environment, productId],
  );
  return {
    product: selected,
    summary: {
      models: new Set(fitments.rows.map((row) => row.vehicle_model_id)).size,
      fitments: fitments.rows.length,
    },
    rows: fitments.rows,
  };
}
