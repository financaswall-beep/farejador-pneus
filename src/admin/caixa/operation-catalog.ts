import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { getCatalogOverview } from '../painel/queries-catalogo.js';

/** Catálogo do web, com projeção operacional que não expõe custos ou margens. */
export async function getMatrizOperationCatalog(db: Pool = pool) {
  const catalog = await getCatalogOverview(undefined, db);
  const fields = ['row_key', 'product_id', 'product_code', 'product_name', 'product_type',
    'brand', 'tire_size', 'tire_condition', 'tire_position', 'vehicle_type', 'tread_pattern',
    'load_index', 'speed_rating', 'catalogued', 'measure_draft', 'compatibility_count',
    'application_count', 'application_search'];
  const rows = catalog.rows.map(raw => {
    const row = raw as Record<string, unknown>;
    return {
      ...Object.fromEntries(fields.map(key => [key, row[key] ?? null])),
      creation_mode: !row.catalogued && row.stock_source ? 'stock' : 'manual',
      has_local_stock: Boolean(row.stock_updated_at),
      local_quantity_on_hand: Number(row.official_quantity_on_hand ?? 0),
      local_quantity_reserved: Number(row.official_quantity_reserved ?? 0),
      local_quantity_available: Number(row.total_stock_available ?? 0),
      local_sale_price_min: row.price_amount ?? null,
      local_sale_price_max: row.price_amount ?? null,
    };
  });
  return { rows, brands: catalog.brands, page: 1, pages: 1, summary: {
    products: rows.length, brands: catalog.brands.length,
    with_local_stock: rows.filter(row => row.local_quantity_available > 0).length,
    without_local_price: rows.filter(row => row.local_sale_price_min == null).length,
  } };
}
