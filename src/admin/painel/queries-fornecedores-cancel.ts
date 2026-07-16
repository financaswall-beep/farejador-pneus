import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { setGalpaoMovContext } from './queries-galpao-movimentos.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';

export interface CancelWholesalePurchaseInput {
  purchase_id: string;
  cancelled_by: string;
  reason: string;
  environment?: 'prod' | 'test';
  idempotency_key: string;
}

interface CancelWholesalePurchaseResult {
  purchase_id: string;
  cancelled_at: string;
  payment_status: string;
}

interface PurchaseStockRemoval {
  measure: string;
  quantity: number;
  movement_count: number;
  before_quantity: number | null;
  before_cost: string | null;
  applied_quantity: number | null;
  applied_cost: string | null;
}

async function reversePurchaseStock(
  client: PoolClient,
  environment: 'prod' | 'test',
  purchaseId: string,
): Promise<PurchaseStockRemoval[]> {
  const items = await client.query<PurchaseStockRemoval>(
    `WITH purchased AS (
       SELECT measure,sum(quantity)::int AS quantity
         FROM commerce.wholesale_purchase_items
        WHERE environment=$1 AND purchase_id=$2 GROUP BY measure
     )
     SELECT p.measure,p.quantity,count(m.id)::int AS movement_count,
            min(m.qty_before)::int AS before_quantity,min(m.cost_before)::text AS before_cost,
            min(m.qty_after)::int AS applied_quantity,min(m.cost_after)::text AS applied_cost
       FROM purchased p
       LEFT JOIN commerce.wholesale_stock_movements m
         ON m.environment=$1 AND m.measure=p.measure AND m.source='compra'
        AND m.ref=$2::text AND m.qty_delta>0
      GROUP BY p.measure,p.quantity ORDER BY p.measure`, [environment, purchaseId]);
  const problems: Array<{ measure: string; available: number; required: number; reason: string }> = [];
  for (const item of items.rows) {
    const stock = await client.query<{ quantity_on_hand: number; unit_cost: string }>(
      `SELECT quantity_on_hand,unit_cost FROM commerce.wholesale_stock
        WHERE environment=$1 AND measure=$2 FOR UPDATE`, [environment, item.measure]);
    const quantity = Number(stock.rows[0]?.quantity_on_hand ?? 0);
    const cost = Number(stock.rows[0]?.unit_cost ?? 0);
    if (item.movement_count !== 1 || item.before_quantity === null
      || item.applied_quantity === null || item.applied_cost === null
      || item.applied_quantity - item.before_quantity !== item.quantity) {
      problems.push({ measure: item.measure, available: quantity,
        required: item.quantity, reason: 'movement_history_missing' });
    } else if (!stock.rows[0] || quantity !== item.applied_quantity) {
      problems.push({ measure: item.measure, available: quantity,
        required: item.quantity, reason: 'quantity_consumed' });
    } else if (Math.abs(cost - Number(item.applied_cost)) > 0.001) {
      problems.push({ measure: item.measure, available: quantity,
        required: item.quantity, reason: 'inventory_cost_changed' });
    }
  }
  if (problems.length) throw new Error('purchase_stock_consumed:' + JSON.stringify(problems));

  await setGalpaoMovContext(client, { source: 'cancelamento_compra', ref: purchaseId });
  for (const item of items.rows) {
    const changed = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand=$3,
              unit_cost=COALESCE($4::numeric,unit_cost)
        WHERE environment=$1 AND measure=$2 AND quantity_on_hand=$5 AND unit_cost=$6::numeric
        RETURNING quantity_on_hand`,
      [environment, item.measure, item.before_quantity, item.before_cost,
       item.applied_quantity, item.applied_cost],
    );
    if (!changed.rows[0]) throw new Error(`purchase_stock_changed:${item.measure}`);
  }
  return items.rows;
}

/** Compra pendente cancela sem estoque. Compra recebida so cancela se quantidade
 * e valor contabil do galpao comportarem a reversao integral. */
export async function cancelWholesalePurchase(
  input: CancelWholesalePurchaseInput,
  dbPool: Pool = defaultPool,
): Promise<CancelWholesalePurchaseResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason?.trim();
  if (!reason || reason.length < 2) throw new Error('reason_required');
  const client = await dbPool.connect();
  const operation = { environment, domain: 'wholesale_purchase.cancel',
    idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint({
      purchase_id: input.purchase_id, reason,
    }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<CancelWholesalePurchaseResult>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const current = await client.query<{
      status: 'pending' | 'confirmed' | 'cancelled'; payment_status: string; stock_applied: boolean;
    }>(
      `SELECT status,payment_status,stock_applied FROM commerce.wholesale_purchases
        WHERE id=$1 AND environment=$2 FOR UPDATE`, [input.purchase_id, environment]);
    if (!current.rows[0]) throw new Error('purchase_not_found');
    if (current.rows[0].status === 'cancelled') throw new Error('purchase_already_cancelled');
    const reversed = current.rows[0].stock_applied
      ? await reversePurchaseStock(client, environment, input.purchase_id) : [];
    const updated = await client.query<{ cancelled_at: string }>(
      `UPDATE commerce.wholesale_purchases
          SET status='cancelled',cancelled_at=now(),cancelled_by=$3,cancel_reason=$4
        WHERE id=$1 AND environment=$2 RETURNING cancelled_at`,
      [input.purchase_id, environment, input.cancelled_by, reason.slice(0, 300)]);
    const result = integrityResult({ purchase_id: input.purchase_id,
      cancelled_at: updated.rows[0]!.cancelled_at,
      payment_status: current.rows[0].payment_status });
    await recordIntegrityEvent(client, { environment, domain: 'wholesale_purchase',
      entityTable: 'commerce.wholesale_purchases', entityId: input.purchase_id,
      eventType: 'cancelled', actorLabel: input.cancelled_by,
      idempotencyKey: operation.idempotencyKey,
      before: { status: current.rows[0].status, stock_applied: current.rows[0].stock_applied },
      after: { status: 'cancelled', reason,
        reversed_stock: reversed } });
    await completeIntegrityOperation(client, operation,
      'commerce.wholesale_purchases', input.purchase_id, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function archiveWholesaleSupplier(
  supplierId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string }> {
  const result = await dbPool.query<{ id: string }>(
    `UPDATE commerce.wholesale_suppliers SET deleted_at=now()
      WHERE id=$1 AND environment=$2 AND deleted_at IS NULL RETURNING id`,
    [supplierId, environment]);
  if (!result.rows[0]) throw new Error('supplier_not_found');
  return result.rows[0];
}
