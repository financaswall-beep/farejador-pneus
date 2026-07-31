import type { PoolClient } from 'pg';
import { canonicalCatalogBrand } from './catalog-brand.js';

interface StockItem {
  measure: string;
  brand?: string | null;
  quantity: number;
}

function aggregateItems(items: StockItem[]): Map<string, { measure: string; brand: string; quantity: number }> {
  const variants = new Map<string, { measure: string; brand: string; quantity: number }>();
  for (const item of items) {
    const measure = item.measure.trim();
    const brand = canonicalCatalogBrand(item.brand) ?? 'Sem marca';
    if (!measure) continue;
    const key = `${measure}\u0000${brand}`;
    const current = variants.get(key) ?? { measure, brand, quantity: 0 };
    current.quantity += item.quantity;
    variants.set(key, current);
  }
  return variants;
}

/**
 * Baixa estrita do galpao. O WHERE repete a invariante de saldo mesmo quando
 * o chamador ja travou a linha: nenhuma corrida ou refatoracao pode transformar
 * falta de estoque em venda confirmada.
 */
export async function applyWholesaleStockDecrement(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: StockItem[],
  enabled: boolean,
  ref?: string,
): Promise<void> {
  if (!enabled) return;
  const variants = aggregateItems(items);
  if (variants.size === 0) return;

  await client.query(
    `SELECT set_config('app.galpao_source', 'venda_atacado', true),
            set_config('app.galpao_ref', COALESCE($1, ''), true)`,
    [ref ?? null],
  );
  for (const { measure, brand, quantity: qty } of [...variants.values()]
    .sort((a, b) => `${a.measure}\u0000${a.brand}`.localeCompare(`${b.measure}\u0000${b.brand}`))) {
    const changed = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand - $4
        WHERE environment = $1 AND measure = $2 AND brand = $3
          AND quantity_on_hand >= $4
        RETURNING quantity_on_hand`,
      [environment, measure, brand, qty],
    );
    if (!changed.rows[0]) {
      const current = await client.query<{ quantity_on_hand: number }>(
        `SELECT quantity_on_hand FROM commerce.wholesale_stock
          WHERE environment=$1 AND measure=$2 AND brand=$3`,
        [environment, measure, brand],
      );
      throw new Error('oversell:' + JSON.stringify([{
        measure, brand, available: Number(current.rows[0]?.quantity_on_hand ?? 0), requested: qty,
      }]));
    }
  }
}

/**
 * Devolucao estrita. O chamador passa somente a quantidade comprovadamente
 * baixada no movimento original, nunca a quantidade nominal vendida.
 */
export async function applyWholesaleStockReturn(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: StockItem[],
  enabled: boolean,
  ref?: string,
): Promise<void> {
  if (!enabled) return;
  const variants = aggregateItems(items);
  if (variants.size === 0) return;

  await client.query(
    `SELECT set_config('app.galpao_source', 'cancelamento_venda', true),
            set_config('app.galpao_ref', COALESCE($1, ''), true)`,
    [ref ?? null],
  );
  for (const { measure, brand, quantity: qty } of [...variants.values()]
    .sort((a, b) => `${a.measure}\u0000${a.brand}`.localeCompare(`${b.measure}\u0000${b.brand}`))) {
    const changed = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand + $4
        WHERE environment = $1 AND measure = $2 AND brand = $3
        RETURNING quantity_on_hand`,
      [environment, measure, brand, qty],
    );
    if (!changed.rows[0]) throw new Error(`stock_variant_missing:${measure}:${brand}`);
  }
}
