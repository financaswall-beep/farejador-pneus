import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { TireVehicleType } from '../../shared/tire-vehicle-type.js';

/** Diagnóstico para revisão administrativa. Não classifica produtos automaticamente. */
export async function getCatalogVehicleInventory(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV, db: Pool = defaultPool,
) {
  const result = await db.query<{
    product_id: string; product_code: string; tire_size: string; brand: string | null;
    tire_condition: string; vehicle_type: TireVehicleType | null;
    fitment_vehicle_types: string[]; fitment_count: number; stock_variant_count: number;
    quantity_on_hand: string; quantity_reserved: string;
  }>(`SELECT p.id product_id,p.product_code,p.brand,p.tire_condition,ts.tire_size,ts.vehicle_type,
       COALESCE(f.vehicle_types,ARRAY[]::text[]) fitment_vehicle_types,COALESCE(f.total,0) fitment_count,
       s.variants stock_variant_count,s.on_hand::text quantity_on_hand,s.reserved::text quantity_reserved
    FROM commerce.products p
    JOIN commerce.tire_specs ts ON ts.product_id=p.id AND ts.environment=p.environment
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT vm.vehicle_type ORDER BY vm.vehicle_type) vehicle_types,count(*)::int total
      FROM commerce.vehicle_fitments vf
      JOIN commerce.vehicle_models vm ON vm.id=vf.vehicle_model_id AND vm.environment=vf.environment
      WHERE vf.environment=ts.environment AND vf.tire_spec_id=ts.id
    ) f ON true
    CROSS JOIN LATERAL (
      SELECT count(*)::int variants,COALESCE(sum(quantity_on_hand),0) on_hand,
        COALESCE(sum(quantity_reserved),0) reserved
      FROM commerce.wholesale_stock ws WHERE ws.environment=ts.environment
        AND commerce.catalog_measure_identity(ws.measure)=commerce.catalog_measure_identity(ts.tire_size)
        AND commerce.catalog_brand_identity(ws.brand)=commerce.catalog_brand_identity(p.brand)
        AND ws.tire_condition=p.tire_condition
    ) s
    WHERE p.environment=$1 AND p.product_type='tire' AND p.deleted_at IS NULL
    ORDER BY ts.tire_size,p.brand,p.product_code`, [environment]);
  const rows = result.rows.map(row => ({ ...row,
    needs_review: row.vehicle_type === null || row.stock_variant_count > 1
      || row.fitment_vehicle_types.some(type => type !== row.vehicle_type),
    // Mesmo uma compatibilidade antiga pode ter sido copiada por medida: é evidência
    // para conferir, nunca autorização de preenchimento em massa.
    classification_basis: 'administrative_review_required' as const,
  }));
  const totals = await db.query(`SELECT count(*)::int stock_variants,
      COALESCE(sum(quantity_on_hand),0)::text quantity_on_hand,
      COALESCE(sum(quantity_reserved),0)::text quantity_reserved,
      COALESCE(sum(quantity_on_hand*unit_cost),0)::text known_stock_cost,
      count(*) FILTER (WHERE unit_cost IS NULL)::int variants_without_cost
    FROM commerce.wholesale_stock WHERE environment=$1`, [environment]);
  return { environment, rows, stock_totals: totals.rows[0],
    summary: { products: rows.length,
      motorcycle: rows.filter(r => r.vehicle_type === 'motorcycle').length,
      car: rows.filter(r => r.vehicle_type === 'car').length,
      unknown: rows.filter(r => r.vehicle_type === null).length,
      needs_review: rows.filter(r => r.needs_review).length },
  };
}
