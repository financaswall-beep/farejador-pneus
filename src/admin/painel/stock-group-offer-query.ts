import type { Pool, PoolClient } from 'pg';
import { tireSizeKey } from '../../shared/tire-size.js';
import type { TireCondition } from '../../shared/tire-condition.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import type { MatrizEnvironment } from './stage5-integrity.js';
import type { MatrizStockGroup } from './stock-groups.js';

export async function listAvailableMatrizStockGroups(db: Pool | PoolClient, environment: MatrizEnvironment, input: {
  measure: string; quantity: number; brand?: string; tireCondition?: TireCondition;
  productIds?: string[]; groupId?: string;
}) {
  const measureKey = tireSizeKey(input.measure).replace(/-/g,'');
  if (!measureKey || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1_000_000) return [];
  type Offer = Pick<MatrizStockGroup,'group_id'|'product_id'|'measure'|'brand'|'tire_condition'|'model'|'conservation_grade'|'revision'|'quantity_available'>;
  return (await db.query<Offer>(`SELECT g.id group_id,g.product_id,s.measure,s.brand,s.tire_condition,
    g.model,g.conservation_grade,g.revision::text,pos.available AS quantity_available
    FROM commerce.matriz_stock_groups g
    JOIN commerce.wholesale_stock s ON s.environment=g.environment AND s.id=g.stock_id
    JOIN LATERAL (SELECT sum(gp.quantity_on_hand-gp.quantity_reserved)::int AS available
      FROM commerce.matriz_stock_group_positions gp WHERE gp.environment=g.environment AND gp.group_id=g.id) pos ON TRUE
    JOIN commerce.products p ON p.environment=g.environment AND p.id=g.product_id
    JOIN commerce.tire_specs ts ON ts.environment=g.environment AND ts.product_id=g.product_id
    WHERE g.environment=$1 AND regexp_replace(s.measure,'[^0-9]','','g')=$2
      AND g.inspection_status='approved' AND ($3=1 OR g.matched_set)
      AND NOT CASE WHEN $3=1 THEN commerce.matriz_stock_origin_candidate_pending(g.environment,g.id)
                   ELSE commerce.matriz_stock_origin_uncertain(g.environment,g.id) END
      AND pos.available >= $3 AND s.unit_cost>0 AND s.vehicle_type IS DISTINCT FROM 'motorcycle'
      AND ($4::text IS NULL OR commerce.catalog_brand_identity(s.brand)=commerce.catalog_brand_identity($4))
      AND ($5::text IS NULL OR s.tire_condition=$5)
      AND ($6::uuid[] IS NULL OR g.product_id=ANY($6)) AND ($7::uuid IS NULL OR g.id=$7)
      AND p.product_type='tire' AND NOT p.partner_generic AND p.deleted_at IS NULL AND ts.vehicle_type='car'
      AND regexp_replace(ts.tire_size,'[^0-9]','','g')=$2 AND p.tire_condition=s.tire_condition
      AND commerce.catalog_brand_identity(p.brand)=commerce.catalog_brand_identity(s.brand)
      AND commerce.matriz_stock_group_model_matches(g.model,ts.tread_pattern)
    ORDER BY pos.available DESC,g.id`,[
    environment,measureKey,input.quantity,canonicalCatalogBrand(input.brand),input.tireCondition??null,input.productIds??null,input.groupId??null,
  ])).rows;
}
