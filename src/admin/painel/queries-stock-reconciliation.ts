import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { buildMatrizStockIndex, matrizStockForMeasure } from '../../shared/matriz-stock-source.js';
import { tireSizeKey } from '../../shared/tire-size.js';

type ReconciliationStatus =
  | 'aligned'
  | 'quantity_divergent'
  | 'catalog_only'
  | 'official_only'
  | 'official_ambiguous'
  | 'official_cost_missing';

interface LegacyRow {
  product_id: string;
  tire_size: string | null;
  brand: string | null;
  legacy_quantity: number | string;
}

interface OfficialRow {
  measure: string;
  quantity_on_hand: number | string;
  unit_cost: number | string | null;
}

export interface MatrizStockReconciliationRow {
  key: string;
  catalog_measures: string[];
  catalog_brands: string[];
  catalog_product_count: number;
  legacy_quantity: number | null;
  official_measures: string[];
  official_quantity: number | null;
  official_unit_cost: number | null;
  official_rows_count: number;
  official_sellable: boolean;
  official_block_reason: string | null;
  status: ReconciliationStatus;
}

export interface MatrizStockReconciliation {
  environment: 'prod' | 'test';
  generated_at: string;
  summary: {
    official_source: 'commerce.wholesale_stock';
    legacy_source: 'commerce.product_full';
    total: number;
    aligned: number;
    divergent: number;
    catalog_only: number;
    official_only: number;
  };
  rows: MatrizStockReconciliationRow[];
}

/** Relatorio sombra: somente SELECT, sem copiar ou corrigir saldo automaticamente. */
export async function getMatrizStockReconciliation(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizStockReconciliation> {
  const legacy = await dbPool.query<LegacyRow>(
    `SELECT product_id, tire_size, brand, total_stock_available AS legacy_quantity
       FROM commerce.product_full
      WHERE environment = $1 AND tire_size IS NOT NULL`,
    [environment],
  );
  const official = await dbPool.query<OfficialRow>(
    `SELECT measure, quantity_on_hand, unit_cost
       FROM commerce.wholesale_stock
      WHERE environment = $1
      ORDER BY measure`,
    [environment],
  );

  const catalogByKey = groupCatalog(legacy.rows);
  const officialIndex = buildMatrizStockIndex(official.rows);
  const keys = [...new Set([...catalogByKey.keys(), ...officialIndex.keys()])].sort();
  const rows = keys.map((key) => reconcileKey(key, catalogByKey.get(key), officialIndex));
  const aligned = rows.filter((row) => row.status === 'aligned').length;
  return {
    environment,
    generated_at: new Date().toISOString(),
    summary: {
      official_source: 'commerce.wholesale_stock',
      legacy_source: 'commerce.product_full',
      total: rows.length,
      aligned,
      divergent: rows.length - aligned,
      catalog_only: rows.filter((row) => row.status === 'catalog_only').length,
      official_only: rows.filter((row) => row.status === 'official_only').length,
    },
    rows,
  };
}

interface CatalogGroup {
  measures: Set<string>;
  brands: Set<string>;
  products: Set<string>;
  quantity: number;
}

function groupCatalog(rows: LegacyRow[]): Map<string, CatalogGroup> {
  const out = new Map<string, CatalogGroup>();
  for (const row of rows) {
    const key = tireSizeKey(row.tire_size);
    if (!key) continue;
    const group = out.get(key) ?? {
      measures: new Set<string>(), brands: new Set<string>(), products: new Set<string>(), quantity: 0,
    };
    if (row.tire_size) group.measures.add(row.tire_size);
    if (row.brand) group.brands.add(row.brand);
    group.products.add(row.product_id);
    group.quantity += Number(row.legacy_quantity) || 0;
    out.set(key, group);
  }
  return out;
}

function reconcileKey(
  key: string,
  catalog: CatalogGroup | undefined,
  officialIndex: ReturnType<typeof buildMatrizStockIndex>,
): MatrizStockReconciliationRow {
  const officialRows = officialIndex.get(key) ?? [];
  const state = matrizStockForMeasure(officialIndex, key);
  const officialQuantity = officialRows.length === 0
    ? null
    : officialRows.reduce((sum, row) => sum + (Number(row.quantity_on_hand) || 0), 0);
  const legacyQuantity = catalog?.quantity ?? null;
  let status: ReconciliationStatus;
  if (!catalog) status = 'official_only';
  else if (officialRows.length === 0) status = 'catalog_only';
  else if (state.block_reason === 'walkin_stock_ambiguous') status = 'official_ambiguous';
  else if (state.block_reason === 'walkin_cost_missing') status = 'official_cost_missing';
  else if (legacyQuantity === officialQuantity) status = 'aligned';
  else status = 'quantity_divergent';

  return {
    key,
    catalog_measures: [...(catalog?.measures ?? [])].sort(),
    catalog_brands: [...(catalog?.brands ?? [])].sort(),
    catalog_product_count: catalog?.products.size ?? 0,
    legacy_quantity: legacyQuantity,
    official_measures: officialRows.map((row) => row.measure).sort(),
    official_quantity: officialQuantity,
    official_unit_cost: state.unit_cost,
    official_rows_count: officialRows.length,
    official_sellable: state.sellable,
    official_block_reason: state.block_reason,
    status,
  };
}
