import type { PoolClient } from 'pg';
import { tireSizeKey } from '../../atendente-v2/wholesale-stock-read.js';

export interface MatrizWalkinStockPlan {
  lines: Array<{ measure: string; quantity: number }>;
  costByProduct: Map<string, number>;
}

interface RequestedItem {
  productId: string;
  quantity: number;
}

interface StockRow {
  measure: string;
  quantity_on_hand: number | string;
  unit_cost: number | string | null;
}

/**
 * Valida e trava o estoque do galpao antes de a venda walk-in nascer.
 * Falha fechada: medida, custo e quantidade precisam estar definidos.
 */
export async function prepareMatrizWalkinStock(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: RequestedItem[],
): Promise<MatrizWalkinStockPlan> {
  const qtyByProduct = new Map<string, number>();
  for (const item of items) {
    if (item.quantity > 0) {
      qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0) + item.quantity);
    }
  }
  if (qtyByProduct.size === 0) throw new Error('walkin_items_required');

  const productIds = [...qtyByProduct.keys()];
  const specs = await client.query<{ product_id: string; tire_size: string | null }>(
    `SELECT product_id, tire_size
       FROM commerce.tire_specs
      WHERE environment = $1 AND product_id = ANY($2::uuid[])`,
    [environment, productIds],
  );
  const sizeByProduct = new Map(specs.rows.map((row) => [row.product_id, row.tire_size]));
  const requestedByKey = new Map<string, number>();
  const productsByKey = new Map<string, string[]>();
  for (const [productId, quantity] of qtyByProduct) {
    const key = tireSizeKey(sizeByProduct.get(productId));
    if (!key) throw new Error('walkin_measure_not_found');
    requestedByKey.set(key, (requestedByKey.get(key) ?? 0) + quantity);
    productsByKey.set(key, [...(productsByKey.get(key) ?? []), productId]);
  }

  const stock = await client.query<StockRow>(
    `SELECT measure, quantity_on_hand, unit_cost
       FROM commerce.wholesale_stock
      WHERE environment = $1
      ORDER BY measure
      FOR UPDATE`,
    [environment],
  );
  const stockByKey = new Map<string, StockRow[]>();
  for (const row of stock.rows) {
    const key = tireSizeKey(row.measure);
    if (key) stockByKey.set(key, [...(stockByKey.get(key) ?? []), row]);
  }

  const lines: MatrizWalkinStockPlan['lines'] = [];
  const costByProduct = new Map<string, number>();
  for (const [key, quantity] of requestedByKey) {
    const matches = stockByKey.get(key) ?? [];
    if (matches.length === 0) throw new Error('walkin_measure_not_found');
    if (matches.length !== 1) throw new Error('walkin_stock_ambiguous');
    const row = matches[0]!;
    const available = Number(row.quantity_on_hand);
    if (!Number.isFinite(available) || available < quantity) {
      throw new Error('walkin_stock_insufficient');
    }
    if (row.unit_cost === null || row.unit_cost === undefined || row.unit_cost === '') {
      throw new Error('walkin_cost_missing');
    }
    const unitCost = Number(row.unit_cost);
    // A migration 0112 preencheu custo desconhecido com DEFAULT 0. Zero nao
    // pode virar lucro ficticio em uma venda comercial normal.
    if (!Number.isFinite(unitCost) || unitCost <= 0) throw new Error('walkin_cost_missing');

    lines.push({ measure: row.measure, quantity });
    for (const productId of productsByKey.get(key) ?? []) costByProduct.set(productId, unitCost);
  }

  return { lines, costByProduct };
}

/** Aplica baixa e trilha usando o mesmo client/transacao da venda. */
export async function applyMatrizWalkinStockSale(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  plan: MatrizWalkinStockPlan,
): Promise<void> {
  await client.query(
    `SELECT set_config('app.galpao_source','varejo',true),
            set_config('app.galpao_ref',$1,true)`,
    [orderId],
  );

  for (const line of plan.lines) {
    const updated = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand - $3
        WHERE environment = $1 AND measure = $2 AND quantity_on_hand >= $3
        RETURNING quantity_on_hand`,
      [environment, line.measure, line.quantity],
    );
    if (updated.rowCount !== 1) throw new Error('walkin_stock_insufficient');
  }

  if (plan.lines.length > 0) {
    await client.query(
      `INSERT INTO audit.events
         (environment, domain, entity_table, entity_id, event_type, actor_label, payload_after)
       VALUES ($1, 'stock', 'commerce.wholesale_stock', $2,
               'matriz_galpao_decrement', 'matriz-venda', $3::jsonb)`,
      [environment, orderId, JSON.stringify({ order_id: orderId, movements: plan.lines.map((line) => ({
        measure: line.measure,
        qty: line.quantity,
      })) })],
    );
  }
}
