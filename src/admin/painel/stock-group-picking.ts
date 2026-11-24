import type { Pool } from 'pg';
import { listMatrizOrderGroupPositionsForOrders } from './stock-groups.js';

type StockPosition = { location_code: string; quantity: number; model: string | null };
export interface StockPickingItem {
  order_item_id: string | null;
  stock_positions?: StockPosition[];
}
export interface StockPickingOrder {
  order_id: string;
  items: StockPickingItem[];
  shared_stock_positions?: Array<{ product_id: string; product_name: string; positions: StockPosition[] }>;
}

/** Recebe apenas pedidos já filtrados por acesso à retirada/entrega da Matriz. */
export async function addStockPickingPositions(
  db: Pool, environment: 'prod' | 'test', orders: StockPickingOrder[],
  stage: 'pending_delivery' | 'open_pickup',
): Promise<void> {
  if (!orders.length) return;
  const positions = await listMatrizOrderGroupPositionsForOrders(db, environment, orders.map(order => order.order_id));
  const byOrder = new Map(orders.map(order => [order.order_id, order]));
  for (const order of orders) {
    delete order.shared_stock_positions;
    for (const item of order.items) delete item.stock_positions;
  }
  for (const position of positions) {
    // Uma venda avulsa para entrega já baixou as unidades quando entra na fila de separação.
    if (position.status !== 'reserved' && !(stage === 'pending_delivery' && position.status === 'consumed')) continue;
    const order = byOrder.get(position.order_id);
    if (!order) continue;
    const { location_code, quantity, model } = position;
    if (position.order_item_id) {
      const item = order.items.find(row => row.order_item_id === position.order_item_id);
      if (item) (item.stock_positions ??= []).push({ location_code, quantity, model });
    } else if (position.matching_items > 1) {
      // A baixa identifica o SKU. Em pedido com linhas repetidas, a separação é por produto.
      const groups = order.shared_stock_positions ??= [];
      let group = groups.find(row => row.product_id === position.product_id);
      if (!group) {
        group = { product_id: position.product_id, product_name: position.product_name, positions: [] };
        groups.push(group);
      }
      const pile = group.positions.find(row => row.location_code === location_code && row.model === model);
      if (pile) pile.quantity += quantity;
      else group.positions.push({ location_code, quantity, model });
    }
  }
}
