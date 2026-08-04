import type { PoolClient } from 'pg';
import { tireSizeKey } from '../../shared/tire-size.js';
import { buildMatrizStockIndex, matrizStockForMeasure } from '../../shared/matriz-stock-source.js';
import type { TireCondition } from '../../shared/tire-condition.js';

function stockBrandKey(value: string | null | undefined): string {
  return (value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface MatrizWalkinStockPlan {
  lines: Array<{ measure: string; brand: string; tire_condition: TireCondition;
    quantity: number }>;
  costByProduct: Map<string, number>;
}

interface RequestedItem {
  productId: string;
  quantity: number;
}

interface StockRow {
  measure: string;
  brand: string;
  tire_condition: TireCondition;
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
  const specs = await client.query<{ product_id: string; product_type: string;
    tire_size: string | null; brand: string | null; tire_condition: TireCondition | null }>(
    `SELECT p.id AS product_id,p.product_type,ts.tire_size,p.brand,p.tire_condition
       FROM commerce.products p
       LEFT JOIN commerce.tire_specs ts
         ON ts.product_id=p.id AND ts.environment=p.environment
      WHERE p.environment = $1 AND p.id = ANY($2::uuid[]) AND p.deleted_at IS NULL`,
    [environment, productIds],
  );
  if (specs.rows.length !== productIds.length) throw new Error('walkin_product_not_sellable');
  const typeByProduct = new Map(specs.rows.map((row) => [row.product_id, row.product_type]));
  const sizeByProduct = new Map(specs.rows.map((row) => [row.product_id, row.tire_size]));
  const brandByProduct = new Map(specs.rows.map((row) => [row.product_id, row.brand]));
  const conditionByProduct = new Map(
    specs.rows.map((row) => [row.product_id, row.tire_condition]),
  );
  const requestedByKey = new Map<string, {
    key: string; brand: string | null; tire_condition: TireCondition; quantity: number;
  }>();
  const productsByKey = new Map<string, string[]>();
  const costByProduct = new Map<string, number>();
  for (const [productId, quantity] of qtyByProduct) {
    const productType = typeByProduct.get(productId);
    if (productType === 'service') {
      costByProduct.set(productId, 0);
      continue;
    }
    if (productType !== 'tire') throw new Error('walkin_product_not_sellable');
    const key = tireSizeKey(sizeByProduct.get(productId));
    if (!key) throw new Error('walkin_measure_not_found');
    const brand = brandByProduct.get(productId) ?? null;
    const tireCondition = conditionByProduct.get(productId) ?? 'meia_vida';
    const variantKey = `${key}\u0000${stockBrandKey(brand)}\u0000${tireCondition}`;
    const current = requestedByKey.get(variantKey) ?? {
      key, brand, tire_condition: tireCondition, quantity: 0,
    };
    current.quantity += quantity;
    requestedByKey.set(variantKey, current);
    productsByKey.set(variantKey, [...(productsByKey.get(variantKey) ?? []), productId]);
  }

  const lines: MatrizWalkinStockPlan['lines'] = [];
  if (requestedByKey.size === 0) return { lines, costByProduct };
  const stock = await client.query<StockRow>(
    `SELECT measure, brand, tire_condition, quantity_on_hand, unit_cost
       FROM commerce.wholesale_stock
      WHERE environment = $1
      ORDER BY measure
      FOR UPDATE`,
    [environment],
  );
  const stockIndex = buildMatrizStockIndex(stock.rows);
  for (const [variantKey, variant] of requestedByKey) {
    const state = matrizStockForMeasure(
      stockIndex, variant.key, variant.brand, variant.tire_condition,
    );
    if (state.block_reason) throw new Error(state.block_reason);
    if (state.quantity_on_hand < variant.quantity) throw new Error('walkin_stock_insufficient');
    lines.push({
      measure: state.measure!, brand: state.brand!,
      tire_condition: variant.tire_condition, quantity: variant.quantity,
    });
    for (const productId of productsByKey.get(variantKey) ?? []) {
      costByProduct.set(productId, state.unit_cost!);
    }
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
          SET quantity_on_hand = quantity_on_hand - $5
        WHERE environment = $1 AND measure = $2 AND brand = $3
          AND tire_condition=$4 AND quantity_on_hand >= $5
        RETURNING quantity_on_hand`,
      [environment, line.measure, line.brand, line.tire_condition, line.quantity],
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
        brand: line.brand,
        tire_condition: line.tire_condition,
        qty: line.quantity,
      })) })],
    );
  }
}
