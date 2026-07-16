import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { applyWholesaleStockReturn } from './wholesale-stock.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';

export interface WholesaleSaleRow {
  id: string;
  buyer_name: string;
  buyer_phone: string | null;
  sold_at: string;
  total_amount: string;
  payment_status: string;
  due_date: string | null;
  status: string;
  items_count: number;
  items: Array<{ measure: string; quantity: number; unit_price: string }>;
}

export async function listWholesaleSales(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  limit = 15,
): Promise<WholesaleSaleRow[]> {
  const result = await dbPool.query<WholesaleSaleRow>(
    `SELECT o.id,c.name AS buyer_name,c.phone AS buyer_phone,o.sold_at,o.total_amount,
            o.payment_status,o.due_date,o.status,
            (SELECT count(*) FROM commerce.wholesale_order_items i WHERE i.order_id=o.id)::int AS items_count,
            COALESCE((SELECT json_agg(json_build_object(
              'measure',i.measure,'quantity',i.quantity,'unit_price',i.unit_price) ORDER BY i.measure)
              FROM commerce.wholesale_order_items i WHERE i.order_id=o.id),'[]'::json) AS items
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_customers c ON c.id=o.buyer_id AND c.environment=o.environment
      WHERE o.environment=$1 ORDER BY o.sold_at DESC LIMIT $2`,
    [environment, limit],
  );
  return result.rows;
}

export interface CancelWholesaleSaleInput {
  order_id: string;
  cancelled_by: string;
  reason: string;
  environment?: 'prod' | 'test';
  idempotency_key: string;
}

interface StockHistoryItem {
  measure: string;
  quantity: number;
}

interface CancelWholesaleSaleResult {
  order_id: string;
  cancelled_at: string;
  payment_status: string;
  stock_returned: StockHistoryItem[];
  stock_unverified: StockHistoryItem[];
}

/** Cancela sem inflar estoque: devolve somente o delta negativo comprovado pelo
 * filme do galpao. Sem filme, bloqueia; filme parcial fica explicito no retorno. */
export async function cancelWholesaleSale(
  input: CancelWholesaleSaleInput,
  dbPool: Pool = defaultPool,
): Promise<CancelWholesaleSaleResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason?.trim();
  if (!reason || reason.length < 2) throw new Error('reason_required');
  const client = await dbPool.connect();
  const operation = { environment, domain: 'wholesale_sale.cancel',
    idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint({
      order_id: input.order_id, reason,
    }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<CancelWholesaleSaleResult>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }

    const current = await client.query<{ status: string; payment_status: string }>(
      `SELECT status,payment_status FROM commerce.wholesale_orders
        WHERE id=$1 AND environment=$2 FOR UPDATE`, [input.order_id, environment]);
    if (!current.rows[0]) throw new Error('sale_not_found');
    if (current.rows[0].status !== 'confirmed') throw new Error('sale_already_cancelled');

    const history = await client.query<{
      measure: string; returned_quantity: number; unverified_quantity: number;
    }>(
      `WITH nominal AS (
         SELECT measure,sum(quantity)::int AS quantity
           FROM commerce.wholesale_order_items
          WHERE environment=$1 AND order_id=$2 GROUP BY measure
       ), filmed AS (
         SELECT measure,(-sum(qty_delta))::int AS quantity
           FROM commerce.wholesale_stock_movements
          WHERE environment=$1 AND source='venda_atacado' AND ref=$2::text AND qty_delta<0
          GROUP BY measure HAVING -sum(qty_delta)>0
       )
       SELECT n.measure,LEAST(n.quantity,COALESCE(f.quantity,0))::int AS returned_quantity,
              GREATEST(n.quantity-COALESCE(f.quantity,0),0)::int AS unverified_quantity
         FROM nominal n LEFT JOIN filmed f USING (measure) ORDER BY n.measure`,
      [environment, input.order_id]);
    const stockReturned = history.rows
      .filter((row) => row.returned_quantity > 0)
      .map((row) => ({ measure: row.measure, quantity: row.returned_quantity }));
    const stockUnverified = history.rows
      .filter((row) => row.unverified_quantity > 0)
      .map((row) => ({ measure: row.measure, quantity: row.unverified_quantity }));
    if (stockReturned.length === 0) {
      throw new Error(`sale_stock_history_missing:${JSON.stringify(stockUnverified)}`);
    }
    await applyWholesaleStockReturn(client, environment, stockReturned, true, input.order_id);

    const updated = await client.query<{ cancelled_at: string }>(
      `UPDATE commerce.wholesale_orders
          SET status='cancelled',cancelled_at=now(),cancelled_by=$3,cancel_reason=$4
        WHERE id=$1 AND environment=$2 RETURNING cancelled_at`,
      [input.order_id, environment, input.cancelled_by, reason.slice(0, 300)]);
    const result = integrityResult({ order_id: input.order_id,
      cancelled_at: updated.rows[0]!.cancelled_at,
      payment_status: current.rows[0].payment_status,
      stock_returned: stockReturned, stock_unverified: stockUnverified });
    await recordIntegrityEvent(client, { environment, domain: 'wholesale_sale',
      entityTable: 'commerce.wholesale_orders', entityId: input.order_id, eventType: 'cancelled',
      actorLabel: input.cancelled_by, idempotencyKey: operation.idempotencyKey,
      before: { status: 'confirmed' }, after: { status: 'cancelled',
        reason, returned_stock: stockReturned, unverified_stock: stockUnverified } });
    await completeIntegrityOperation(client, operation, 'commerce.wholesale_orders', input.order_id, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
