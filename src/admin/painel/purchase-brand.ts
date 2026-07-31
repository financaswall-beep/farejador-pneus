import type { PoolClient } from 'pg';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { canonicalCatalogBrand } from './catalog-brand.js';

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
  void actorLabel;
  return items.map((item) => {
    const brand = canonicalCatalogBrand(item.brand) ?? 'Sem marca';
    return {
      ...item,
      measure: measures.get(item.measure.trim())!,
      brand,
    };
  });
}
