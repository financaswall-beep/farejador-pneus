import type { PoolClient } from 'pg';
import { tireSizeKey } from '../shared/tire-size.js';
import { buildMatrizStockIndex, matrizStockForMeasure } from '../shared/matriz-stock-source.js';
import type { TireCondition } from '../shared/tire-condition.js';
import {
  loadMatrizOfficialStock, loadMatrizProductStockSpecs, stockBrandKey,
} from './matriz-stock-variants.js';

interface RequestedItem { productId: string; quantity: number }
interface ReservationMovement {
  measure: string;
  brand: string;
  tire_condition: TireCondition;
  qty: number;
}

async function buildReservationPlan(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: RequestedItem[],
): Promise<ReservationMovement[]> {
  const qtyByProduct = new Map<string, number>();
  for (const item of items) {
    if (item.quantity > 0) {
      qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0) + item.quantity);
    }
  }
  if (qtyByProduct.size === 0) return [];

  const specs = await loadMatrizProductStockSpecs(client, environment, [...qtyByProduct.keys()]);
  const specByProduct = new Map(specs.map((row) => [row.product_id, row]));
  const requested = new Map<string, {
    key: string; brand: string | null; tire_condition: TireCondition; quantity: number;
  }>();
  for (const [productId, quantity] of qtyByProduct) {
    const spec = specByProduct.get(productId);
    const key = tireSizeKey(spec?.tire_size);
    if (!key) throw new Error('walkin_measure_not_found');
    const brand = spec?.brand ?? null;
    const tireCondition = spec?.tire_condition ?? 'meia_vida';
    const variantKey = `${key}\u0000${stockBrandKey(brand)}\u0000${tireCondition}`;
    const current = requested.get(variantKey) ?? {
      key, brand, tire_condition: tireCondition, quantity: 0,
    };
    current.quantity += quantity;
    requested.set(variantKey, current);
  }

  const stockIndex = buildMatrizStockIndex(
    await loadMatrizOfficialStock(client, environment, true),
  );
  const plan: ReservationMovement[] = [];
  for (const item of requested.values()) {
    const state = matrizStockForMeasure(
      stockIndex, item.key, item.brand, item.tire_condition,
    );
    if (state.block_reason) throw new Error(state.block_reason);
    if (state.quantity_available < item.quantity) throw new Error('walkin_stock_insufficient');
    plan.push({
      measure: state.measure!, brand: state.brand!,
      tire_condition: item.tire_condition, qty: item.quantity,
    });
  }
  return plan;
}

async function hasEvent(
  client: PoolClient, environment: 'prod' | 'test', orderId: string, eventType: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM audit.events
      WHERE environment=$1 AND entity_id=$2 AND event_type=$3 LIMIT 1`,
    [environment, orderId, eventType],
  );
  return result.rows.length > 0;
}

async function reservationMovements(
  client: PoolClient, environment: 'prod' | 'test', orderId: string,
): Promise<ReservationMovement[]> {
  const result = await client.query<{ payload_after: { movements?: ReservationMovement[] } }>(
    `SELECT payload_after FROM audit.events
      WHERE environment=$1 AND entity_id=$2
        AND event_type IN ('matriz_galpao_reserved','matriz_galpao_reservation_adjusted')
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    [environment, orderId],
  );
  return result.rows[0]?.payload_after?.movements ?? [];
}

/** Remove somente as reservas dos itens excluídos. O chamador trava o pedido e
 * engloba itens, total e este ajuste na mesma transação. Mantém a trilha anterior. */
export async function releaseRemovedMatrizItems(
  client: PoolClient, environment: 'prod' | 'test', orderId: string, items: RequestedItem[],
): Promise<void> {
  if (await hasEvent(client, environment, orderId, 'matriz_galpao_decrement')
    || await hasEvent(client, environment, orderId, 'matriz_galpao_reservation_released')) {
    throw new Error('stock_reservation_not_editable');
  }
  const previous = await reservationMovements(client, environment, orderId);
  if (!previous.length) throw new Error('stock_reservation_not_found');
  const movements = previous.map(row => ({ ...row }));
  const specs = await loadMatrizProductStockSpecs(client, environment, items.map(item => item.productId));
  const released = new Map<number, number>();
  for (const item of items) {
    const spec = specs.find(row => row.product_id === item.productId);
    const index = movements.findIndex(row => spec && tireSizeKey(row.measure) === tireSizeKey(spec.tire_size)
      && stockBrandKey(row.brand) === stockBrandKey(spec.brand)
      && row.tire_condition === spec.tire_condition);
    if (index < 0 || !Number.isSafeInteger(item.quantity) || item.quantity <= 0
      || movements[index]!.qty < item.quantity) throw new Error('stock_reservation_items_mismatch');
    movements[index]!.qty -= item.quantity;
    released.set(index, (released.get(index) ?? 0) + item.quantity);
  }
  for (const [index, quantity] of released) {
    const row = previous[index]!;
    const updated = await client.query(
      `UPDATE commerce.wholesale_stock SET quantity_reserved=quantity_reserved-$5
        WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4
          AND quantity_reserved >= $5 RETURNING quantity_reserved`,
      [environment, row.measure, row.brand, row.tire_condition, quantity],
    );
    if (updated.rowCount !== 1) throw new Error('stock_reservation_insufficient');
  }
  await client.query(
    `INSERT INTO audit.events
       (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after,created_at)
     VALUES ($1,'stock','commerce.wholesale_stock',$2,'matriz_galpao_reservation_adjusted',
       'agent_v2_bot',$3::jsonb,$4::jsonb,clock_timestamp())`,
    [environment, orderId, JSON.stringify({ movements: previous }),
      JSON.stringify({ order_id: orderId, movements: movements.filter(row => row.qty > 0) })],
  );
}

/** Reserva sem alterar o saldo fisico. Deve rodar na transacao que cria o pedido. */
export async function reserveMatrizGalpaoStock(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  items: RequestedItem[],
  enabled: boolean,
): Promise<void> {
  if (!enabled || items.length === 0) return;
  if (await hasEvent(client, environment, orderId, 'matriz_galpao_reserved')) return;
  const movements = await buildReservationPlan(client, environment, items);
  // O plano acima trava o estoque. Rele a trilha depois da trava para que duas
  // chamadas simultaneas do mesmo pedido nao reservem duas vezes.
  if (await hasEvent(client, environment, orderId, 'matriz_galpao_reserved')) return;
  for (const movement of movements) {
    const updated = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_reserved=quantity_reserved+$5
        WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4
          AND quantity_on_hand-quantity_reserved >= $5
        RETURNING quantity_reserved`,
      [environment, movement.measure, movement.brand, movement.tire_condition, movement.qty],
    );
    if (updated.rowCount !== 1) throw new Error('walkin_stock_insufficient');
  }
  if (movements.length > 0) {
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
       VALUES ($1,'stock','commerce.wholesale_stock',$2,
               'matriz_galpao_reserved','matriz-pedido',$3::jsonb)`,
      [environment, orderId, JSON.stringify({ order_id: orderId, movements })],
    );
  }
}

/** Entrega/retirada: reserva vira baixa fisica, de forma idempotente. */
export async function consumeMatrizGalpaoReservation(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
): Promise<void> {
  if (await hasEvent(client, environment, orderId, 'matriz_galpao_decrement')) return;
  if (await hasEvent(client, environment, orderId, 'matriz_galpao_reservation_released')) {
    throw new Error('stock_reservation_already_released');
  }
  const movements = await reservationMovements(client, environment, orderId);
  if (movements.length === 0) return; // pedido legado/manual: ja baixou ou nao controla galpao
  await client.query(
    `SELECT set_config('app.galpao_source','varejo',true),
            set_config('app.galpao_ref',$1,true)`,
    [orderId],
  );
  for (const movement of movements) {
    const updated = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand=quantity_on_hand-$5,
              quantity_reserved=quantity_reserved-$5
        WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4
          AND quantity_reserved >= $5 AND quantity_on_hand >= $5
        RETURNING quantity_on_hand,quantity_reserved`,
      [environment, movement.measure, movement.brand, movement.tire_condition, movement.qty],
    );
    if (updated.rowCount !== 1) throw new Error(`stock_reservation_insufficient:${movement.measure}`);
  }
  await client.query(
    `INSERT INTO audit.events
       (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
     VALUES ($1,'stock','commerce.wholesale_stock',$2,
             'matriz_galpao_decrement','matriz-realizacao',$3::jsonb)`,
    [environment, orderId, JSON.stringify({ order_id: orderId, movements })],
  );
}

/** Cancelamento antes da realizacao: libera a reserva sem mexer no fisico. */
export async function releaseMatrizGalpaoReservation(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
): Promise<void> {
  if (await hasEvent(client, environment, orderId, 'matriz_galpao_decrement')) return;
  if (await hasEvent(client, environment, orderId, 'matriz_galpao_reservation_released')) return;
  const movements = await reservationMovements(client, environment, orderId);
  if (movements.length === 0) return;
  for (const movement of movements) {
    const updated = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_reserved=quantity_reserved-$5
        WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4
          AND quantity_reserved >= $5
        RETURNING quantity_reserved`,
      [environment, movement.measure, movement.brand, movement.tire_condition, movement.qty],
    );
    if (updated.rowCount !== 1) throw new Error(`stock_reservation_insufficient:${movement.measure}`);
  }
  await client.query(
    `INSERT INTO audit.events
       (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
     VALUES ($1,'stock','commerce.wholesale_stock',$2,
             'matriz_galpao_reservation_released','matriz-cancel',$3::jsonb)`,
    [environment, orderId, JSON.stringify({ order_id: orderId, movements })],
  );
}
