import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, moneyCents,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import { postPartnerArrivalLedgerAdjustment } from './partner-transfer-arrival-ledger.js';
import {
  assertWholesaleSaleMoney, MAX_WHOLESALE_SALE_CENTS,
} from './sales-money.js';

type Environment = 'prod' | 'test';

export interface PartnerArrivalAdjustmentInput {
  order_id: string;
  items: Array<{ order_item_id: string; accepted_quantity: number }>;
  cargo_additions?: Array<{ cargo_lot_id: string; quantity: number; unit_price: number }>;
  idempotency_key: string;
  actor_label: string;
  environment?: Environment;
}

interface ArrivalOrderItem {
  id: string;
  measure: string;
  brand: string;
  tire_condition: 'meia_vida' | 'novo' | 'remold';
  quantity: number;
  unit_price: string;
  unit_cost: string;
}

function uniqueIds(rows: Array<{ order_item_id?: string; cargo_lot_id?: string }>, key: 'order_item_id' | 'cargo_lot_id'): boolean {
  const values = rows.map((row) => row[key]).filter(Boolean);
  return new Set(values).size === values.length;
}

async function lockArrivalOrder(
  client: PoolClient,
  environment: Environment,
  orderId: string,
): Promise<{ purchase_id: string; payment_status: 'paid' | 'pending' }> {
  const result = await client.query<{
    purchase_id: string; payment_status: 'paid' | 'pending';
  }>(
    `SELECT p.id AS purchase_id,o.payment_status
       FROM commerce.wholesale_orders o
       JOIN commerce.partner_purchases p
         ON p.environment=o.environment AND p.source_wholesale_order_id=o.id
        AND p.deleted_at IS NULL
      WHERE o.environment=$1 AND o.id=$2 AND o.status='confirmed'
        AND o.partner_unit_id IS NOT NULL AND o.partner_transfer_status='in_transit'
        AND p.receipt_status='pending'
      FOR UPDATE OF o,p`,
    [environment, orderId],
  );
  if (!result.rows[0]) throw new Error('matrix_partner_transfer_not_in_transit');
  return result.rows[0];
}

async function createRejectedCargo(
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

async function allocateCargoAddition(
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

export async function settlePartnerArrival(
  input: PartnerArrivalAdjustmentInput,
  dbPool: Pool = defaultPool,
): Promise<Record<string, unknown>> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const cargoAdditions = input.cargo_additions ?? [];
  let finalTotalCents = cargoAdditions.length ? assertWholesaleSaleMoney(
    cargoAdditions.map((item) => ({ quantity: item.quantity, unit_price: item.unit_price })),
  ) : 0;
  if (!uniqueIds(input.items, 'order_item_id') || !uniqueIds(cargoAdditions, 'cargo_lot_id')) {
    throw new Error('matrix_partner_arrival_duplicate_item');
  }
  const client = await dbPool.connect();
  const operation = { environment, domain: 'matrix_partner.arrival',
    idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint({
      order_id: input.order_id, items: input.items,
      cargo_additions: cargoAdditions, actor_label: input.actor_label,
    }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<Record<string, unknown>>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const order = await lockArrivalOrder(client, environment, input.order_id);
    await client.query(`SELECT set_config('app.matrix_partner_bridge','on',true),
                               set_config('app.matrix_partner_arrival','on',true)`);
    const items = await client.query<ArrivalOrderItem>(
      `SELECT id,measure,brand,tire_condition,quantity,unit_price,unit_cost
         FROM commerce.wholesale_order_items
        WHERE environment=$1 AND order_id=$2 AND source_cargo_lot_id IS NULL
        ORDER BY created_at,id FOR UPDATE`,
      [environment, input.order_id],
    );
    const acceptedById = new Map(input.items.map((row) => [row.order_item_id, row.accepted_quantity]));
    if (!items.rows.length || acceptedById.size !== items.rows.length
        || items.rows.some((row) => !acceptedById.has(row.id))) {
      throw new Error('matrix_partner_arrival_items_mismatch');
    }
    const rejectedCargo: Array<Record<string, unknown>> = [];
    for (const item of items.rows) {
      const accepted = Number(acceptedById.get(item.id));
      if (!Number.isInteger(accepted) || accepted < 0 || accepted > Number(item.quantity)) {
        throw new Error('matrix_partner_arrival_quantity_invalid');
      }
      finalTotalCents += accepted * moneyCents(Number(item.unit_price));
      if (!Number.isSafeInteger(finalTotalCents)
          || finalTotalCents > MAX_WHOLESALE_SALE_CENTS) {
        throw new Error('sale_total_too_large');
      }
      await client.query(
        `UPDATE commerce.wholesale_order_items SET accepted_quantity=$3
          WHERE environment=$1 AND id=$2`,
        [environment, item.id, accepted],
      );
      const rejected = Number(item.quantity) - accepted;
      const cargoLotId = await createRejectedCargo(client, environment, item, rejected, input);
      if (cargoLotId) rejectedCargo.push({ cargo_lot_id: cargoLotId,
        order_item_id: item.id, quantity: rejected });
    }

    const allocated: Array<Record<string, unknown>> = [];
    for (const addition of [...cargoAdditions].sort((a, b) => a.cargo_lot_id.localeCompare(b.cargo_lot_id))) {
      allocated.push(await allocateCargoAddition(
        client, environment, order.purchase_id, addition, input,
      ));
    }
    await client.query(
      `UPDATE commerce.partner_purchase_items p
          SET confirmed_quantity=i.accepted_quantity
         FROM commerce.wholesale_order_items i
        WHERE p.environment=$1 AND p.purchase_id=$2
          AND i.environment=p.environment AND i.id=p.source_wholesale_order_item_id`,
      [environment, order.purchase_id],
    );
    const total = await client.query<{ total_amount: string; accepted_units: number }>(
      `SELECT COALESCE(sum(accepted_quantity*unit_price),0)::numeric(12,2)::text AS total_amount,
              COALESCE(sum(accepted_quantity),0)::int AS accepted_units
         FROM commerce.wholesale_order_items WHERE environment=$1 AND order_id=$2`,
      [environment, input.order_id],
    );
    if (moneyCents(Number(total.rows[0]!.total_amount)) !== finalTotalCents) {
      throw new Error('matrix_partner_arrival_total_mismatch');
    }
    await client.query(
      `UPDATE commerce.wholesale_orders
          SET settled_total_amount=$3,partner_transfer_status='settled'
        WHERE environment=$1 AND id=$2`,
      [environment, input.order_id, total.rows[0]!.total_amount],
    );
    await client.query(
      `UPDATE commerce.partner_purchases SET total_amount=$3
        WHERE environment=$1 AND id=$2`,
      [environment, order.purchase_id, total.rows[0]!.total_amount],
    );
    if (order.payment_status === 'pending') {
      const payable = await client.query(
        `UPDATE finance.partner_payables
            SET amount=$3,status=CASE WHEN $3::numeric=0 THEN 'cancelled' ELSE 'open' END,
                updated_at=now()
          WHERE environment=$1 AND source_purchase_id=$2 AND deleted_at IS NULL
            AND status='open'`,
        [environment, order.purchase_id, total.rows[0]!.total_amount],
      );
      if (!payable.rowCount) throw new Error('matrix_partner_payable_not_open');
    }
    await postPartnerArrivalLedgerAdjustment(
      client, environment, input.order_id, input.actor_label,
    );
    const result = {
      order_id: input.order_id, purchase_id: order.purchase_id,
      partner_transfer_status: 'settled', total_amount: total.rows[0]!.total_amount,
      accepted_units: total.rows[0]!.accepted_units,
      rejected_cargo: rejectedCargo, allocated_cargo: allocated,
    };
    await recordIntegrityEvent(client, { environment, domain: 'matrix_partner_transfer',
      entityTable: 'commerce.wholesale_orders', entityId: input.order_id,
      eventType: 'arrival_settled', actorLabel: input.actor_label,
      idempotencyKey: input.idempotency_key, after: result });
    await completeIntegrityOperation(
      client, operation, 'commerce.wholesale_orders', input.order_id, result,
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
