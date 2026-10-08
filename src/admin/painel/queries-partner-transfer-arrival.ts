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

import { lockArrivalOrder, createRejectedCargo, allocateCargoAddition, uniqueIds, type ArrivalOrderItem } from './partner-arrival-items.js';

export async function settlePartnerArrivalOnClient(
  client: PoolClient,
  input: PartnerArrivalAdjustmentInput,
): Promise<Record<string, unknown>> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const cargoAdditions = input.cargo_additions ?? [];
  let finalTotalCents = cargoAdditions.length ? assertWholesaleSaleMoney(
    cargoAdditions.map((item) => ({ quantity: item.quantity, unit_price: item.unit_price })),
  ) : 0;
  if (!uniqueIds(input.items, 'order_item_id') || !uniqueIds(cargoAdditions, 'cargo_lot_id')) {
    throw new Error('matrix_partner_arrival_duplicate_item');
  }
  const operation = { environment, domain: 'matrix_partner.arrival',
    idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint({
      order_id: input.order_id, items: input.items,
      cargo_additions: cargoAdditions, actor_label: input.actor_label,
    }) };
  const started = await beginIntegrityOperation<Record<string, unknown>>(client, operation);
  if (started.replayed) {
    return started.result;
  }
  const order = await lockArrivalOrder(client, environment, input.order_id);
  const settledAt = new Date().toISOString();
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
        SET settled_total_amount=$3,partner_transfer_status='settled',status='confirmed',partner_settled_at=$4::timestamptz,
            payment_status=CASE WHEN partner_payment_terms='cash_on_arrival'
                                THEN 'paid' ELSE 'pending' END,
            paid_at=CASE WHEN partner_payment_terms='cash_on_arrival'
                         THEN $4::timestamptz ELSE NULL END
      WHERE environment=$1 AND id=$2`,
    [environment, input.order_id, total.rows[0]!.total_amount, settledAt],
  );
  await client.query(
    `UPDATE commerce.partner_purchases
        SET total_amount=$3,
            payment_status=CASE WHEN $4='cash_on_arrival' THEN 'paid_now' ELSE 'payable' END,
            payable_due_date=CASE WHEN $4='cash_on_arrival' THEN NULL ELSE payable_due_date END,
            payment_method=CASE WHEN $4='cash_on_arrival'
                                THEN 'Pago à Matriz no acerto' ELSE payment_method END
      WHERE environment=$1 AND id=$2`,
    [environment, order.purchase_id, total.rows[0]!.total_amount,
      order.partner_payment_terms],
  );
  const payable = await client.query(
    `UPDATE finance.partner_payables
        SET amount=$3,
            status=CASE WHEN $3::numeric=0 THEN 'cancelled'
                        WHEN $4='cash_on_arrival' THEN 'paid' ELSE 'open' END,
            paid_at=CASE WHEN $3::numeric>0 AND $4='cash_on_arrival'
                         THEN $5::timestamptz ELSE NULL END,
            payment_method=CASE WHEN $4='cash_on_arrival'
                                THEN 'acerto_na_chegada' ELSE payment_method END,
            updated_at=now()
      WHERE environment=$1 AND source_purchase_id=$2 AND deleted_at IS NULL
        AND status='open'`,
    [environment, order.purchase_id, total.rows[0]!.total_amount,
      order.partner_payment_terms, settledAt],
  );
  if (!payable.rowCount) throw new Error('matrix_partner_payable_not_open');
  await postPartnerArrivalLedgerAdjustment(
    client, environment, input.order_id, input.actor_label, settledAt,
  );
  const result = {
    order_id: input.order_id, purchase_id: order.purchase_id,
    partner_transfer_status: 'settled', total_amount: total.rows[0]!.total_amount,
    payment_status: order.partner_payment_terms === 'cash_on_arrival' ? 'paid' : 'pending',
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
  return result;
}

export async function settlePartnerArrival(
  input: PartnerArrivalAdjustmentInput, dbPool: Pool = defaultPool,
): Promise<Record<string, unknown>> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await settlePartnerArrivalOnClient(client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
