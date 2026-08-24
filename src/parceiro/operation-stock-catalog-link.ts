import type { PoolClient } from 'pg';
import type { PartnerContext } from './auth.js';

type StockCatalogCandidate = {
  item_type: 'pneu' | 'insumo' | 'servico';
  tire_size: string | null;
  brand: string | null;
  tire_condition: string | null;
};

/** Vincula somente uma variante canônica inequívoca; item livre continua local. */
export async function resolveCatalogProductForStock(
  client: PoolClient,
  ctx: PartnerContext,
  row: StockCatalogCandidate,
): Promise<string | null> {
  if (row.item_type !== 'pneu' || !row.tire_size || !row.tire_condition) return null;
  const result = await client.query<{ id: string }>(
    `SELECT p.id
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
  return result.rows.length === 1 ? result.rows[0]!.id : null;
}
