import type { PoolClient } from 'pg';

function aggregateItems(items: Array<{ measure: string; quantity: number }>): Map<string, number> {
  const byMeasure = new Map<string, number>();
  for (const item of items) {
    const measure = item.measure.trim();
    if (measure) byMeasure.set(measure, (byMeasure.get(measure) ?? 0) + item.quantity);
  }
  return byMeasure;
}

/**
 * Baixa estrita do galpao. O WHERE repete a invariante de saldo mesmo quando
 * o chamador ja travou a linha: nenhuma corrida ou refatoracao pode transformar
 * falta de estoque em venda confirmada.
 */
export async function applyWholesaleStockDecrement(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: Array<{ measure: string; quantity: number }>,
  enabled: boolean,
  ref?: string,
): Promise<void> {
  if (!enabled) return;
  const byMeasure = aggregateItems(items);
  if (byMeasure.size === 0) return;

  await client.query(
    `SELECT set_config('app.galpao_source', 'venda_atacado', true),
            set_config('app.galpao_ref', COALESCE($1, ''), true)`,
    [ref ?? null],
  );
  for (const [measure, qty] of [...byMeasure].sort(([a], [b]) => a.localeCompare(b))) {
    const changed = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand - $3
        WHERE environment = $1 AND measure = $2 AND quantity_on_hand >= $3
        RETURNING quantity_on_hand`,
      [environment, measure, qty],
    );
    if (!changed.rows[0]) {
      const current = await client.query<{ quantity_on_hand: number }>(
        `SELECT quantity_on_hand FROM commerce.wholesale_stock
          WHERE environment=$1 AND measure=$2`,
        [environment, measure],
      );
      throw new Error('oversell:' + JSON.stringify([{
        measure, available: Number(current.rows[0]?.quantity_on_hand ?? 0), requested: qty,
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
  items: Array<{ measure: string; quantity: number }>,
  enabled: boolean,
  ref?: string,
): Promise<void> {
  if (!enabled) return;
  const byMeasure = aggregateItems(items);
  if (byMeasure.size === 0) return;

  await client.query(
    `SELECT set_config('app.galpao_source', 'cancelamento_venda', true),
            set_config('app.galpao_ref', COALESCE($1, ''), true)`,
    [ref ?? null],
  );
  for (const [measure, qty] of [...byMeasure].sort(([a], [b]) => a.localeCompare(b))) {
    const changed = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand + $3
        WHERE environment = $1 AND measure = $2
        RETURNING quantity_on_hand`,
      [environment, measure, qty],
    );
    if (!changed.rows[0]) throw new Error(`stock_measure_missing:${measure}`);
  }
}
