import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { moneyCents } from '../../shared/catalog-pricing.js';
import { buildMatrizStockIndex, matrizStockForMeasure } from '../../shared/matriz-stock-source.js';
import { tireSizeKey } from '../../shared/tire-size.js';
import type { TireCondition } from '../../shared/tire-condition.js';
import { matchesTireVehicleType, type TireVehicleType, type TireVehicleFilter } from '../../shared/tire-vehicle-type.js';
import { loadVehicleApplicationCatalog } from '../../shared/vehicle-application-catalog.js';
import { catalogApplicationSummary, pendingCatalogMeasures } from './catalog-measure-registration.js';
interface CatalogRow {
  product_id: string; product_code: string; product_name: string; product_type: string;
  tire_condition: TireCondition | null;
  vehicle_type: TireVehicleType | null;
  brand: string | null; tire_size: string | null; tire_position: string | null;
  tire_construction?: 'radial' | 'bias' | null;
  tread_pattern: string | null; load_index: string | null; speed_rating: string | null;
  price_amount: string | null; currency: string | null; price_type: string | null;
  compatibility_count: number | string;
}
interface StockRow {
  measure: string; brand: string; quantity_on_hand: number | string;
  quantity_reserved: number | string;
  tire_condition: TireCondition;
  unit_cost: number | string | null;
  updated_at: string | null;
}
interface PurchaseRow {
  measure: string; brand: string | null; unit_cost: number | string; purchased_at: string;
  tire_condition: TireCondition;
}

function brandKey(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalized === 'semmarca' ? '' : normalized;
}
function catalogVariantKey(
  measure: string | null | undefined,
  brand: string | null | undefined,
  tireCondition: string | null | undefined,
): string {
  return `${tireSizeKey(measure)}\u0000${brandKey(brand)}\u0000${tireCondition ?? ''}`;
}

export async function getCatalogOverview(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  vehicleType: TireVehicleFilter = 'all',
): Promise<{ summary: Record<string, number>; brands: string[]; rows: unknown[] }> {
  const [catalog, stock, purchases, measures] = await Promise.all([
    dbPool.query<CatalogRow>(
      `SELECT p.id product_id,p.product_code,p.product_name,p.product_type,
              p.tire_condition,p.brand,
              ts.tire_size,ts.vehicle_type,ts.position tire_position,ts.construction tire_construction,
              ts.tread_pattern,ts.load_index,ts.speed_rating,
              cp.price_amount,cp.currency,cp.price_type,
              COALESCE((
                SELECT count(DISTINCT vf.vehicle_model_id)::int
                  FROM commerce.vehicle_fitments vf
                 WHERE vf.environment=p.environment
                   AND vf.tire_spec_id=ts.id
              ),0) AS compatibility_count
         FROM commerce.products p
         LEFT JOIN commerce.tire_specs ts
           ON ts.product_id=p.id AND ts.environment=p.environment
         LEFT JOIN commerce.matriz_current_prices cp
           ON cp.product_id=p.id AND cp.environment=p.environment
        WHERE p.environment=$1 AND p.deleted_at IS NULL
        ORDER BY p.brand NULLS LAST,p.product_name`,
      [environment],
    ),
    dbPool.query<StockRow>(
      `SELECT measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost,updated_at
         FROM commerce.wholesale_stock WHERE environment=$1`,
      [environment],
    ),
    dbPool.query<PurchaseRow>(
      `SELECT i.measure,i.brand,i.tire_condition,i.unit_cost,p.purchased_at
         FROM commerce.wholesale_purchase_items i
         JOIN commerce.wholesale_purchases p
           ON p.id=i.purchase_id AND p.environment=i.environment
        WHERE i.environment=$1 AND p.status='confirmed'
        ORDER BY p.purchased_at DESC,i.created_at DESC`,
      [environment],
    ),
    dbPool.query<{ measure: string; vehicle_type: TireVehicleType | null }>(
      `SELECT measure,vehicle_type FROM commerce.catalog_measure_registrations WHERE environment=$1 ORDER BY measure`,
      [environment],
    ),
  ]);
  const applications = await loadVehicleApplicationCatalog(dbPool, environment);
  const stockIndex = buildMatrizStockIndex(stock.rows);
  const stockByKey = new Map(stock.rows.map((row) => [
    catalogVariantKey(row.measure, row.brand, row.tire_condition), row,
  ]));
  const lastPurchase = new Map<string, PurchaseRow>();
  for (const row of purchases.rows) {
    const key = catalogVariantKey(row.measure, row.brand, row.tire_condition);
    if (tireSizeKey(row.measure) && !lastPurchase.has(key)) lastPurchase.set(key, row);
  }
  const catalogKeys = new Set(catalog.rows.map((product) =>
    catalogVariantKey(product.tire_size, product.brand, product.tire_condition)));
  const catalogRows = catalog.rows.map((product) => {
    const state = matrizStockForMeasure(
      stockIndex, product.tire_size, product.brand, product.tire_condition,
    );
    const key = catalogVariantKey(
      product.tire_size, product.brand, product.tire_condition,
    );
    const officialStock = tireSizeKey(product.tire_size) ? stockByKey.get(key) : undefined;
    const purchase = tireSizeKey(product.tire_size) ? lastPurchase.get(key) : undefined;
    const cost = state.unit_cost;
    const price = product.price_amount === null ? null : Number(product.price_amount);
    const usablePrice = price !== null && Number.isFinite(price) && price > 0;
    if (product.product_type === 'service') {
      return {
        ...product,
        compatibility_count: 0,
        row_key: `product:${product.product_id}`,
        catalogued: true,
        price_amount: price,
        official_quantity_on_hand: null,
        official_quantity_reserved: null,
        total_stock_available: null,
        official_unit_cost: null,
        stock_source: null,
        stock_updated_at: null,
        last_purchase_cost: null,
        last_purchase_at: null,
        gross_profit: null,
        margin_percent: null,
        sellable: usablePrice,
        block_reason: usablePrice ? null : 'catalog_price_missing',
      };
    }
    return {
      ...product,
      compatibility_count: Number(product.compatibility_count ?? 0),
      ...catalogApplicationSummary(applications, product.tire_size, product.vehicle_type),
      row_key: `product:${product.product_id}`,
      catalogued: true,
      price_amount: price,
      official_quantity_on_hand: state.quantity_on_hand,
      official_quantity_reserved: state.quantity_reserved,
      total_stock_available: state.quantity_available,
      official_unit_cost: cost,
      stock_source: 'commerce.wholesale_stock',
      stock_updated_at: officialStock?.updated_at ?? null,
      last_purchase_cost: purchase ? Number(purchase.unit_cost) : null,
      last_purchase_at: purchase?.purchased_at ?? null,
      gross_profit: usablePrice && cost !== null
        ? (moneyCents(price) - moneyCents(cost)) / 100 : null,
      margin_percent: usablePrice && cost !== null
        ? ((moneyCents(price) - moneyCents(cost)) / moneyCents(price)) * 100 : null,
      sellable: state.sellable && usablePrice,
      block_reason: usablePrice ? state.block_reason : 'catalog_price_missing',
    };
  });
  const stockOnlyRows = stock.rows
    .filter((row) => !catalogKeys.has(
      catalogVariantKey(row.measure, row.brand, row.tire_condition),
    ))
    .map((row) => {
      const key = catalogVariantKey(row.measure, row.brand, row.tire_condition);
      const purchase = lastPurchase.get(key);
      return {
        product_id: null,
        product_code: null,
        product_name: row.brand,
        product_type: 'tire',
        tire_condition: row.tire_condition,
        vehicle_type: null,
        brand: row.brand,
        tire_size: row.measure,
        tire_position: null,
        tread_pattern: null,
        load_index: null,
        speed_rating: null,
        price_amount: null,
        currency: null,
        price_type: null,
        compatibility_count: null,
        ...catalogApplicationSummary(applications, row.measure),
        row_key: `stock:${tireSizeKey(row.measure)}:${brandKey(row.brand)}:${row.tire_condition}`,
        catalogued: false,
        official_quantity_on_hand: Number(row.quantity_on_hand),
        official_quantity_reserved: Number(row.quantity_reserved ?? 0),
        total_stock_available: Math.max(Number(row.quantity_on_hand) - Number(row.quantity_reserved ?? 0), 0),
        official_unit_cost: row.unit_cost === null ? null : Number(row.unit_cost),
        stock_source: 'commerce.wholesale_stock',
        stock_updated_at: row.updated_at,
        last_purchase_cost: purchase ? Number(purchase.unit_cost) : null,
        last_purchase_at: purchase?.purchased_at ?? null,
        gross_profit: null,
        margin_percent: null,
        sellable: false,
        block_reason: 'catalog_product_missing',
      };
    });
  const measureRows = pendingCatalogMeasures(measures.rows, [...catalogRows, ...stockOnlyRows], applications);
  const rows = [...catalogRows, ...stockOnlyRows, ...measureRows]
    .filter(row => matchesTireVehicleType(row.vehicle_type, vehicleType)).sort((a, b) =>
    String(a.brand ?? '').localeCompare(String(b.brand ?? ''), 'pt-BR')
    || String(a.tire_size ?? '').localeCompare(String(b.tire_size ?? ''), 'pt-BR')
    || String(a.product_name).localeCompare(String(b.product_name), 'pt-BR'));
  const brands = [...new Set(rows.map((row) => row.brand).filter((brand): brand is string => Boolean(brand)))];
  return {
    summary: {
      products: catalogRows.filter(row => matchesTireVehicleType(row.vehicle_type, vehicleType)).length,
      incomplete_registrations: measureRows.filter(row => matchesTireVehicleType(row.vehicle_type, vehicleType)).length,
      stock_only: stockOnlyRows.filter(row => matchesTireVehicleType(row.vehicle_type, vehicleType)).length,
      brands: brands.length,
      without_price: [...catalogRows, ...stockOnlyRows].filter(row => matchesTireVehicleType(row.vehicle_type, vehicleType))
        .filter((row) => row.price_amount === null
          || !Number.isFinite(Number(row.price_amount)) || Number(row.price_amount) <= 0).length,
      with_stock: rows.filter((row) => Number(row.total_stock_available ?? 0) > 0).length,
      without_position: catalogRows.filter((row) => row.product_type === 'tire'
        && matchesTireVehicleType(row.vehicle_type, vehicleType)
        && row.tire_position === null).length,
    },
    brands,
    rows,
  };
}

export { getCatalogPriceHistory, setCatalogPrice, type CatalogPriceInput } from './queries-catalogo-prices.js';
