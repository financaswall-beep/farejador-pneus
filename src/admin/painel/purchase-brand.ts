import type { PoolClient } from 'pg';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { canonicalCatalogBrand, syncCatalogBrandForMeasure } from './catalog-brand.js';

export interface PurchaseItemInput {
  measure: string;
  brand?: string | null;
  quantity: number;
  unit_cost: number;
}

/** Canoniza medida/marca e impede que o estoque por medida esconda marcas misturadas. */
export async function canonicalPurchaseItems(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: PurchaseItemInput[],
  actorLabel: string,
): Promise<PurchaseItemInput[]> {
  if (!items.length) throw new Error('items_required');
  const measures = new Map<string, string>();
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error('quantity_invalid');
    if (!Number.isFinite(item.unit_cost) || item.unit_cost < 0) throw new Error('cost_invalid');
    const raw = item.measure.trim();
    if (!measures.has(raw)) {
      const catalog = await resolveMeasureInCatalog(client, environment, raw);
      if (!catalog) throw new Error('measure_not_in_catalog');
      measures.set(raw, catalog.measure);
    }
  }
  const canonical = items.map((item) => ({
    ...item,
    measure: measures.get(item.measure.trim())!,
    brand: canonicalCatalogBrand(item.brand),
  }));
  const brandsByMeasure = new Map<string, Set<string>>();
  for (const item of canonical) {
    if (!item.brand) continue;
    const brands = brandsByMeasure.get(item.measure) ?? new Set<string>();
    brands.add(item.brand);
    brandsByMeasure.set(item.measure, brands);
  }
  if ([...brandsByMeasure.values()].some((brands) => brands.size > 1)) {
    throw new Error('stock_measure_brand_conflict');
  }
  for (const [measure, brands] of brandsByMeasure) {
    await syncCatalogBrandForMeasure(client, {
      environment, measure, brand: [...brands][0], actorLabel,
    });
  }
  return canonical;
}
