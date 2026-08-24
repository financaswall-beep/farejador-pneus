import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';

export type PartnerPanelCatalogType = 'all' | 'tire' | 'service';
export type PartnerPanelCatalogFilter = 'all' | 'stock' | 'no_price';

export interface PartnerPanelCatalogInput {
  page?: number;
  limit?: number;
  q?: string;
  brand?: string;
  type?: PartnerPanelCatalogType;
  filter?: PartnerPanelCatalogFilter;
}

type CatalogRow = {
  product_id: string;
  product_code: string;
  product_name: string;
  product_type: string;
  tire_condition: string | null;
  brand: string | null;
  tire_size: string | null;
  tire_position: string | null;
  local_stock_rows: number | string;
  local_quantity_on_hand: number | string;
  local_quantity_reserved: number | string;
  local_quantity_available: number | string;
  local_sale_price_min: string | null;
  local_sale_price_max: string | null;
  compatibility_count: number | string;
};

type CompatibilityRow = {
  vehicle_model_id: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  position: 'front' | 'rear' | 'both';
  is_oem: boolean;
};

const CATALOG_WHERE = `p.environment=$1 AND p.deleted_at IS NULL
  AND ($2::text IS NULL OR p.product_code ILIKE $2 ESCAPE '\\'
    OR p.product_name ILIKE $2 ESCAPE '\\'
    OR COALESCE(p.brand,'') ILIKE $2 ESCAPE '\\'
    OR COALESCE(ts.tire_size,'') ILIKE $2 ESCAPE '\\')
  AND ($3::text IS NULL OR lower(p.brand)=lower($3))
  AND ($4::text='all' OR ($4='tire' AND p.product_type='tire')
    OR ($4='service' AND p.product_type='service'))
  AND ($5::text='all'
    OR ($5='stock' AND EXISTS (
      SELECT 1 FROM commerce.partner_stock_levels scoped_stock
       WHERE scoped_stock.environment=p.environment AND scoped_stock.unit_id=$6
         AND scoped_stock.product_id=p.id AND scoped_stock.deleted_at IS NULL
         AND GREATEST(COALESCE(scoped_stock.quantity_on_hand,0)
           - COALESCE(scoped_stock.quantity_reserved,0),0)>0
    ))
    OR ($5='no_price' AND EXISTS (
      SELECT 1 FROM commerce.partner_stock_levels scoped_stock
       WHERE scoped_stock.environment=p.environment AND scoped_stock.unit_id=$6
         AND scoped_stock.product_id=p.id AND scoped_stock.deleted_at IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM commerce.partner_stock_levels priced_stock
       WHERE priced_stock.environment=p.environment AND priced_stock.unit_id=$6
         AND priced_stock.product_id=p.id AND priced_stock.deleted_at IS NULL
         AND priced_stock.sale_price>0
    )))`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function moneyOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export class PartnerPanelCatalogNotFoundError extends Error {
  constructor() {
    super('catalog_product_not_found');
  }
}

export async function getPartnerPanelCatalog(
  ctx: PartnerContext,
  input: PartnerPanelCatalogInput = {},
) {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 40)));
  const query = String(input.q ?? '').trim().slice(0, 120);
  const brand = String(input.brand ?? '').trim().slice(0, 80) || null;
  const type: PartnerPanelCatalogType = input.type === 'tire' || input.type === 'service'
    ? input.type : 'all';
  const filter: PartnerPanelCatalogFilter = input.filter === 'stock' || input.filter === 'no_price'
    ? input.filter : 'all';
  const like = query ? `%${escapeLike(query)}%` : null;

  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const filters = [ctx.environment, like, brand, type, filter, ctx.unitId];
    const summaryResult = await client.query<{
      products: number | string;
      brands: number | string;
      with_local_stock: number | string;
      without_local_price: number | string;
      local_units_available: number | string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM commerce.products p
           WHERE p.environment=$1 AND p.deleted_at IS NULL) products,
         (SELECT count(DISTINCT lower(btrim(p.brand)))::int FROM commerce.products p
           WHERE p.environment=$1 AND p.deleted_at IS NULL
             AND p.brand IS NOT NULL AND btrim(p.brand)<>'') brands,
         (SELECT count(DISTINCT psl.product_id)::int
            FROM commerce.partner_stock_levels psl
           WHERE psl.environment=$1 AND psl.unit_id=$2 AND psl.deleted_at IS NULL
             AND psl.product_id IS NOT NULL
             AND GREATEST(COALESCE(psl.quantity_on_hand,0)
               - COALESCE(psl.quantity_reserved,0),0)>0) with_local_stock,
         (SELECT count(DISTINCT psl.product_id)::int
            FROM commerce.partner_stock_levels psl
           WHERE psl.environment=$1 AND psl.unit_id=$2 AND psl.deleted_at IS NULL
             AND psl.product_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM commerce.partner_stock_levels priced
                WHERE priced.environment=psl.environment AND priced.unit_id=psl.unit_id
                  AND priced.product_id=psl.product_id AND priced.deleted_at IS NULL
                  AND priced.sale_price>0
             )) without_local_price,
         (SELECT COALESCE(sum(GREATEST(COALESCE(psl.quantity_on_hand,0)
                    - COALESCE(psl.quantity_reserved,0),0)),0)::int
            FROM commerce.partner_stock_levels psl
           WHERE psl.environment=$1 AND psl.unit_id=$2
             AND psl.deleted_at IS NULL) local_units_available`,
      [ctx.environment, ctx.unitId],
    );
    const totalResult = await client.query<{ total: number | string }>(
      `SELECT count(*)::int total
         FROM commerce.products p
         LEFT JOIN commerce.tire_specs ts
           ON ts.environment=p.environment AND ts.product_id=p.id
        WHERE ${CATALOG_WHERE}`,
      filters,
    );
    const brandsResult = await client.query<{ brand: string; product_count: number | string }>(
      `SELECT btrim(brand) brand,count(*)::int product_count
         FROM commerce.products
        WHERE environment=$1 AND deleted_at IS NULL
          AND brand IS NOT NULL AND btrim(brand)<>''
        GROUP BY btrim(brand)
        ORDER BY brand`,
      [ctx.environment],
    );
    const rowsResult = await client.query<CatalogRow>(
      `SELECT p.id product_id,p.product_code,p.product_name,p.product_type,
              p.tire_condition,p.brand,ts.tire_size,ts.position tire_position,
              COALESCE(local.stock_rows,0)::int local_stock_rows,
              COALESCE(local.quantity_on_hand,0)::int local_quantity_on_hand,
              COALESCE(local.quantity_reserved,0)::int local_quantity_reserved,
              COALESCE(local.quantity_available,0)::int local_quantity_available,
              local.sale_price_min::text local_sale_price_min,
              local.sale_price_max::text local_sale_price_max,
              COALESCE((SELECT count(*)::int
                          FROM commerce.vehicle_fitments vf
                         WHERE vf.environment=ts.environment
                           AND vf.tire_spec_id=ts.id),0)::int compatibility_count
         FROM commerce.products p
         LEFT JOIN commerce.tire_specs ts
           ON ts.environment=p.environment AND ts.product_id=p.id
         LEFT JOIN LATERAL (
           SELECT count(*)::int stock_rows,
                  sum(COALESCE(psl.quantity_on_hand,0))::int quantity_on_hand,
                  sum(COALESCE(psl.quantity_reserved,0))::int quantity_reserved,
                  sum(GREATEST(COALESCE(psl.quantity_on_hand,0)-COALESCE(psl.quantity_reserved,0),0))::int quantity_available,
                  min(psl.sale_price) sale_price_min,max(psl.sale_price) sale_price_max
             FROM commerce.partner_stock_levels psl
            WHERE psl.environment=p.environment AND psl.unit_id=$6
              AND psl.product_id=p.id AND psl.deleted_at IS NULL
         ) local ON true
        WHERE ${CATALOG_WHERE}
        ORDER BY p.brand NULLS LAST,ts.tire_size NULLS LAST,p.product_name,p.id
        LIMIT $7 OFFSET $8`,
      [...filters, limit, (page - 1) * limit],
    );
    const total = finiteNumber(totalResult.rows[0]?.total);
    const summary = summaryResult.rows[0];
    return {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      brands: brandsResult.rows.map((row) => row.brand),
      brand_counts: Object.fromEntries(brandsResult.rows.map((row) => [
        row.brand, finiteNumber(row.product_count),
      ])),
      summary: {
        products: finiteNumber(summary?.products),
        brands: finiteNumber(summary?.brands),
        with_local_stock: finiteNumber(summary?.with_local_stock),
        without_local_price: finiteNumber(summary?.without_local_price),
        local_units_available: finiteNumber(summary?.local_units_available),
      },
      rows: rowsResult.rows.map((row) => ({
        product_id: row.product_id,
        product_code: row.product_code,
        product_name: row.product_name,
        product_type: row.product_type,
        tire_condition: row.tire_condition,
        brand: row.brand,
        tire_size: row.tire_size,
        tire_position: row.tire_position,
        has_local_stock: finiteNumber(row.local_stock_rows) > 0,
        local_stock_rows: finiteNumber(row.local_stock_rows),
        local_quantity_on_hand: finiteNumber(row.local_quantity_on_hand),
        local_quantity_reserved: finiteNumber(row.local_quantity_reserved),
        local_quantity_available: finiteNumber(row.local_quantity_available),
        local_sale_price_min: moneyOrNull(row.local_sale_price_min),
        local_sale_price_max: moneyOrNull(row.local_sale_price_max),
        compatibility_count: finiteNumber(row.compatibility_count),
      })),
    };
  });
}

export async function getPartnerPanelCatalogCompatibility(
  ctx: PartnerContext,
  productId: string,
) {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const productResult = await client.query<{
      product_id: string;
      product_code: string;
      product_name: string;
      brand: string | null;
      tire_condition: string | null;
      tire_size: string | null;
    }>(
      `SELECT p.id product_id,p.product_code,p.product_name,p.brand,
              p.tire_condition,ts.tire_size
         FROM commerce.products p
         LEFT JOIN commerce.tire_specs ts
           ON ts.environment=p.environment AND ts.product_id=p.id
        WHERE p.environment=$1 AND p.id=$2 AND p.product_type='tire'
          AND p.deleted_at IS NULL LIMIT 1`,
      [ctx.environment, productId],
    );
    const product = productResult.rows[0];
    if (!product) throw new PartnerPanelCatalogNotFoundError();

    const fitments = await client.query<CompatibilityRow>(
      `SELECT DISTINCT vm.id vehicle_model_id,vm.make,vm.model,vm.variant,
              vm.year_start,vm.year_end,vf.position,vf.is_oem
         FROM commerce.products p
         JOIN commerce.tire_specs ts
           ON ts.environment=p.environment AND ts.product_id=p.id
         JOIN commerce.vehicle_fitments vf
           ON vf.environment=ts.environment AND vf.tire_spec_id=ts.id
         JOIN commerce.vehicle_models vm
           ON vm.environment=vf.environment AND vm.id=vf.vehicle_model_id
        WHERE p.environment=$1 AND p.id=$2 AND p.deleted_at IS NULL
          AND vm.deleted_at IS NULL
        ORDER BY vm.make,vm.model,vm.variant NULLS FIRST,vf.position`,
      [ctx.environment, productId],
    );
    return {
      product,
      summary: {
        models: new Set(fitments.rows.map((row) => row.vehicle_model_id)).size,
        fitments: fitments.rows.length,
      },
      rows: fitments.rows,
    };
  });
}
