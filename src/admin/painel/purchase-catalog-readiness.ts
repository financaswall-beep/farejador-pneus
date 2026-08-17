import type { PoolClient } from 'pg';
import { tireSizeKey } from '../../shared/tire-size.js';
import type { PurchaseItemInput } from './purchase-brand.js';

export interface PurchaseCatalogBlocker {
  measure: string;
  brand: string;
  tire_condition: PurchaseItemInput['tire_condition'];
  reason: 'catalog_product_missing' | 'catalog_price_missing';
  product_id: string | null;
}

function brandKey(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalized === 'semmarca' ? '' : normalized;
}

function variantKey(
  measure: string, brand: string | null | undefined, tireCondition: string,
): string {
  return `${tireSizeKey(measure)}\u0000${brandKey(brand)}\u0000${tireCondition}`;
}

/**
 * Compras pode receber uma marca ainda nao pronta para varejo/Bot, mas isso
 * nunca deve acontecer em silencio. O retorno vira uma tarefa explicita para
 * a aba Catalogo; as vendas continuam bloqueadas ate produto e preco existirem.
 */
export async function getPurchaseCatalogBlockers(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: PurchaseItemInput[],
): Promise<PurchaseCatalogBlocker[]> {
  const measures = [...new Set(items.map((item) => item.measure))];
  const rows = await client.query<{
    product_id: string; tire_size: string; brand: string | null;
    tire_condition: PurchaseItemInput['tire_condition']; price_amount: string | null;
  }>(
    `SELECT p.id product_id,ts.tire_size,p.brand,p.tire_condition,cp.price_amount
       FROM commerce.products p
       JOIN commerce.tire_specs ts
         ON ts.environment=p.environment AND ts.product_id=p.id
       LEFT JOIN commerce.matriz_current_prices cp
         ON cp.environment=p.environment AND cp.product_id=p.id
      WHERE p.environment=$1 AND p.deleted_at IS NULL
        AND ts.tire_size=ANY($2::text[])`,
    [environment, measures],
  );
  const catalog = new Map(rows.rows.map((row) => [
    variantKey(row.tire_size, row.brand, row.tire_condition), row,
  ]));
  const unique = new Map<string, PurchaseCatalogBlocker>();
  for (const item of items) {
    const key = variantKey(item.measure, item.brand, item.tire_condition);
    if (unique.has(key)) continue;
    const row = catalog.get(key);
    if (!row) {
      unique.set(key, { measure: item.measure, brand: item.brand ?? 'Sem marca',
        tire_condition: item.tire_condition, reason: 'catalog_product_missing',
        product_id: null });
    } else if (row.price_amount === null) {
      unique.set(key, { measure: item.measure, brand: item.brand ?? 'Sem marca',
        tire_condition: item.tire_condition, reason: 'catalog_price_missing',
        product_id: row.product_id });
    }
  }
  return [...unique.values()];
}
