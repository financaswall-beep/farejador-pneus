import type { PoolClient } from 'pg';
import type { PartnerContext } from './auth.js';
import type { TireVehicleType } from '../shared/tire-vehicle-type.js';

type StockCatalogCandidate = {
  item_type: 'pneu' | 'insumo' | 'servico';
  tire_size: string | null;
  brand: string | null;
  tire_condition: string | null;
  vehicle_type?: TireVehicleType;
};

/** Vincula somente uma variante canônica inequívoca; item livre continua local. */
export async function resolveCatalogProductForStock(
  client: PoolClient,
  ctx: PartnerContext,
  row: StockCatalogCandidate,
): Promise<string | null> {
  if (row.item_type !== 'pneu' || !row.tire_size || !row.tire_condition) return null;
  const result = await client.query<{ id: string; vehicle_type: TireVehicleType | null }>(
    `SELECT p.id,ts.vehicle_type
       FROM commerce.products p
       JOIN commerce.tire_specs ts
         ON ts.environment=p.environment AND ts.product_id=p.id
      WHERE p.environment=$1 AND p.product_type='tire' AND p.deleted_at IS NULL
        AND commerce.catalog_measure_identity(ts.tire_size)
            =commerce.catalog_measure_identity($2)
        AND commerce.catalog_brand_identity(p.brand)
            =commerce.catalog_brand_identity($3)
        AND p.tire_condition IS NOT DISTINCT FROM $4
      ORDER BY p.id LIMIT 2`,
    [ctx.environment, row.tire_size, row.brand, row.tire_condition],
  );
  if (result.rows.length !== 1) return null;
  const product = result.rows[0]!;
  if (row.vehicle_type && product.vehicle_type && row.vehicle_type !== product.vehicle_type) {
    throw new Error('stock_vehicle_type_conflict');
  }
  return product.id;
}
