import type { PoolClient } from 'pg';
import type { PartnerArrivalAdjustmentInput } from './queries-partner-transfer-arrival.js';
type Environment = 'prod' | 'test';
export interface ArrivalOrderItem {
  id: string;
  measure: string;
  brand: string;
  tire_condition: 'meia_vida' | 'novo' | 'remold';
  quantity: number;
  unit_price: string;
  unit_cost: string;
}

interface ArrivalOrderLock {
  purchase_id: string; payment_status: 'paid' | 'pending';
  partner_payment_terms: 'cash_on_arrival' | 'credit';
}
export function uniqueIds(rows: Array<{ order_item_id?: string; cargo_lot_id?: string }>, key: 'order_item_id' | 'cargo_lot_id'): boolean {
  const values = rows.map((row) => row[key]).filter(Boolean);
  return new Set(values).size === values.length;
}

export async function lockArrivalOrder(
  client: PoolClient,
  environment: Environment,
  orderId: string,
): Promise<ArrivalOrderLock> {
  const result = await client.query<ArrivalOrderLock>(
    `SELECT p.id AS purchase_id,o.payment_status,o.partner_payment_terms
       FROM commerce.wholesale_orders o
       JOIN commerce.partner_purchases p
         ON p.environment=o.environment AND p.source_wholesale_order_id=o.id
        AND p.deleted_at IS NULL
      WHERE o.environment=$1 AND o.id=$2 AND o.status='pending'
        AND o.partner_unit_id IS NOT NULL AND o.partner_transfer_status='in_transit'
        AND p.receipt_status='pending'
      FOR UPDATE OF o,p`,
    [environment, orderId],
  );
  if (!result.rows[0]) throw new Error('matrix_partner_transfer_not_in_transit');
  return result.rows[0];
}

export async function createRejectedCargo(
  client: PoolClient,
  environment: Environment,
  item: ArrivalOrderItem,
  rejected: number,
  input: PartnerArrivalAdjustmentInput,
): Promise<string | null> {
  if (rejected === 0) return null;
  const lot = await client.query<{ id: string }>(
    `INSERT INTO commerce.matrix_partner_cargo_lots (
       environment,source_wholesale_order_item_id,measure,brand,tire_condition,
       unit_cost,quantity_loaded,quantity_available,status,created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'open',$8)
     RETURNING id`,
    [environment, item.id, item.measure, item.brand, item.tire_condition,
      item.unit_cost, rejected, input.actor_label],
  );
  const cargoLotId = lot.rows[0]!.id;
  await client.query(
    `INSERT INTO commerce.matrix_partner_cargo_events (
       environment,cargo_lot_id,event_type,quantity,target_wholesale_order_id,
       actor_label,reason,idempotency_key
     ) VALUES ($1,$2,'rejected',$3,$4,$5,'Recusado no acerto da chegada',$6)`,
    [environment, cargoLotId, rejected, input.order_id, input.actor_label,
      `${input.idempotency_key}:rejected:${item.id}`],
  );
  return cargoLotId;
}

export async function allocateCargoAddition(
  client: PoolClient,
  environment: Environment,
  purchaseId: string,
  addition: { cargo_lot_id: string; quantity: number; unit_price: number },
  input: PartnerArrivalAdjustmentInput,
): Promise<{ order_item_id: string; cargo_lot_id: string; quantity: number }> {
  const result = await client.query<{
    id: string; measure: string; brand: string;
    tire_condition: 'meia_vida' | 'novo' | 'remold'; unit_cost: string;
    quantity_available: number;
  }>(
    `SELECT id,measure,brand,tire_condition,unit_cost,quantity_available
       FROM commerce.matrix_partner_cargo_lots
      WHERE environment=$1 AND id=$2 AND status='open'
      FOR UPDATE`,
    [environment, addition.cargo_lot_id],
  );
  const lot = result.rows[0];
  if (!lot) throw new Error('matrix_partner_cargo_not_found');
  if (addition.quantity > Number(lot.quantity_available)) {
    throw new Error('matrix_partner_cargo_insufficient');
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO commerce.wholesale_order_items (
       environment,order_id,measure,brand,tire_condition,quantity,unit_price,
       unit_cost,accepted_quantity,source_cargo_lot_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6,$9)
     RETURNING id`,
    [environment, input.order_id, lot.measure, lot.brand, lot.tire_condition,
      addition.quantity, addition.unit_price, lot.unit_cost, lot.id],
  );
  const orderItemId = inserted.rows[0]!.id;
  await client.query(
    `UPDATE commerce.matrix_partner_cargo_lots
        SET quantity_available=quantity_available-$3,
            status=CASE WHEN quantity_available-$3=0 THEN 'closed' ELSE 'open' END
      WHERE environment=$1 AND id=$2`,
    [environment, lot.id, addition.quantity],
  );
  await client.query(
    `INSERT INTO commerce.matrix_partner_cargo_events (
       environment,cargo_lot_id,event_type,quantity,target_wholesale_order_id,
       actor_label,reason,idempotency_key
     ) VALUES ($1,$2,'allocated',$3,$4,$5,'Redirecionado na chegada',$6)`,
    [environment, lot.id, addition.quantity, input.order_id, input.actor_label,
      `${input.idempotency_key}:allocated:${lot.id}`],
  );
  await client.query(
    `INSERT INTO commerce.partner_purchase_items (
       environment,purchase_id,product_id,item_name,quantity,unit_cost,
       tire_condition,tire_size,brand,sale_price,source_wholesale_order_item_id,
       confirmed_quantity
     ) VALUES ($1,$2,NULL,$3,$4,$5,$6,$3,$7,NULL,$8,$4)`,
    [environment, purchaseId, lot.measure, addition.quantity, addition.unit_price,
      lot.tire_condition, lot.brand, orderItemId],
  );
  return { order_item_id: orderItemId, cargo_lot_id: lot.id, quantity: addition.quantity };
}
