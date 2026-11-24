import type { Pool } from 'pg';
import { listMatrizOrderGroupPositionsForOrders } from './stock-groups.js';

export interface StockPickingItem {
  order_item_id: string | null;
  stock_positions?: Array<{ location_code: string; quantity: number; model: string | null }>;
}

/** Recebe apenas pedidos já filtrados por acesso à retirada/entrega da Matriz. */
export async function addStockPickingPositions(
  db: Pool, environment: 'prod' | 'test', orders: Array<{ order_id: string; items: StockPickingItem[] }>,
): Promise<void> {
  if (!orders.length) return;
  const positions = await listMatrizOrderGroupPositionsForOrders(db, environment, orders.map(order => order.order_id));
  const byItem = new Map<string, NonNullable<StockPickingItem['stock_positions']>>();
  for (const position of positions) {
    if (position.status !== 'reserved' || !position.order_item_id) continue;
    const key = `${position.order_id}:${position.order_item_id}`;
    const rows = byItem.get(key) || [];
    rows.push({ location_code: position.location_code, quantity: position.quantity, model: position.model });
    byItem.set(key, rows);
  }
  for (const order of orders) {
    for (const item of order.items) {
      if (!item.order_item_id) continue;
      const rows = byItem.get(`${order.order_id}:${item.order_item_id}`);
      if (rows) item.stock_positions = rows;
    }
  }
}
