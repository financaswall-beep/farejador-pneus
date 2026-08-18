import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { applyWholesaleStockReturn } from './wholesale-stock.js';
import {
  getWholesaleSaleLedgerState, postWholesaleSaleCancellation,
} from './matriz-ledger-wholesale-sales.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import type { TireCondition } from '../../shared/tire-condition.js';
import { salesPeriodWhere, type SalesPeriod } from './queries-galpao.js';
import { cancelLinkedPartnerPurchase } from './wholesale-partner-bridge.js';

export interface WholesaleSaleRow {
  id: string;
  buyer_id: string;
  partner_id: string | null;
  partner_unit_id: string | null;
  partner_unit_name: string | null;
  parent_order_id: string | null;
  partner_transfer_status: 'in_transit' | 'settled' | 'received' | null;
  partner_payment_terms: 'cash_on_arrival' | 'credit' | null;
  dispatched_total_amount: string | null;
  settled_total_amount: string | null;
  partner_purchase_id: string | null;
  partner_receipt_status: 'pending' | 'received' | null;
  expected_units: number | null;
  received_units: number | null;
  buyer_name: string;
  buyer_phone: string | null;
  sold_at: string;
  total_amount: string;
  payment_status: string;
  due_date: string | null;
  status: string;
  items_count: number;
  items: Array<{ measure: string; brand: string | null; tire_condition: TireCondition;
    quantity: number; dispatched_quantity: number; accepted_quantity: number | null;
    source_cargo_lot_id: string | null;
    unit_price: string }>;
}

export async function listWholesaleSales(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  limit = 15,
): Promise<WholesaleSaleRow[]> {
  const result = await dbPool.query<WholesaleSaleRow>(
    `SELECT o.id,o.buyer_id,c.partner_id,o.partner_unit_id,pu.display_name AS partner_unit_name,
            o.parent_order_id,o.partner_transfer_status,o.dispatched_total_amount,
            o.settled_total_amount,o.partner_payment_terms,
            linked.partner_purchase_id,linked.partner_receipt_status,
            linked.expected_units,linked.received_units,
            c.name AS buyer_name,c.phone AS buyer_phone,o.sold_at,
            COALESCE(o.settled_total_amount,o.total_amount) AS total_amount,
            o.payment_status,o.due_date,o.status,
            (SELECT count(*) FROM commerce.wholesale_order_items i WHERE i.order_id=o.id)::int AS items_count,
            COALESCE((SELECT json_agg(json_build_object(
              'id',i.id,'measure',i.measure,'brand',i.brand,'tire_condition',i.tire_condition,
              'quantity',CASE WHEN o.partner_transfer_status IN ('settled','received')
                THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END,
              'dispatched_quantity',i.quantity,'accepted_quantity',i.accepted_quantity,
              'source_cargo_lot_id',i.source_cargo_lot_id,'unit_price',i.unit_price)
              ORDER BY i.measure,i.brand,i.tire_condition)
              FROM commerce.wholesale_order_items i WHERE i.order_id=o.id),'[]'::json) AS items
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_customers c ON c.id=o.buyer_id AND c.environment=o.environment
       LEFT JOIN network.partner_units pu
         ON pu.environment=o.environment AND pu.id=o.partner_unit_id
       LEFT JOIN LATERAL (
         SELECT p.id AS partner_purchase_id,p.receipt_status AS partner_receipt_status,
                COALESCE(sum(COALESCE(i.confirmed_quantity,i.quantity)),0)::int AS expected_units,
                COALESCE(sum(i.received_quantity),0)::int AS received_units
           FROM commerce.partner_purchases p
           LEFT JOIN commerce.partner_purchase_items i
             ON i.environment=p.environment AND i.purchase_id=p.id
          WHERE p.environment=o.environment AND p.source_wholesale_order_id=o.id
            AND p.deleted_at IS NULL
          GROUP BY p.id,p.receipt_status
       ) linked ON true
      WHERE o.environment=$1 ORDER BY o.sold_at DESC LIMIT $2`,
    [environment, limit],
  );
  return result.rows;
}

/** Histórico completo do atacado dentro de uma janela operacional curta.
 *  Não usa o limite de 15 da lista de vendas recentes. */
export async function listWholesaleSalesHistory(
  period: SalesPeriod,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleSaleRow[]> {
  const periodWhere = salesPeriodWhere(period, 'o.sold_at');
  const result = await dbPool.query<WholesaleSaleRow>(
    `SELECT o.id,o.buyer_id,c.partner_id,o.partner_unit_id,pu.display_name AS partner_unit_name,
            o.parent_order_id,o.partner_transfer_status,o.dispatched_total_amount,
            o.settled_total_amount,o.partner_payment_terms,
            linked.partner_purchase_id,linked.partner_receipt_status,
            linked.expected_units,linked.received_units,
            c.name AS buyer_name,c.phone AS buyer_phone,o.sold_at,
            COALESCE(o.settled_total_amount,o.total_amount) AS total_amount,
            o.payment_status,o.due_date,o.status,
            (SELECT count(*) FROM commerce.wholesale_order_items i
              WHERE i.order_id=o.id AND i.environment=o.environment)::int AS items_count,
            COALESCE((SELECT json_agg(json_build_object(
              'id',i.id,'measure',i.measure,'brand',i.brand,'tire_condition',i.tire_condition,
              'quantity',CASE WHEN o.partner_transfer_status IN ('settled','received')
                THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END,
              'dispatched_quantity',i.quantity,'accepted_quantity',i.accepted_quantity,
              'source_cargo_lot_id',i.source_cargo_lot_id,'unit_price',i.unit_price)
              ORDER BY i.measure,i.brand,i.tire_condition)
              FROM commerce.wholesale_order_items i
             WHERE i.order_id=o.id AND i.environment=o.environment),'[]'::json) AS items
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_customers c
         ON c.id=o.buyer_id AND c.environment=o.environment
       LEFT JOIN network.partner_units pu
         ON pu.environment=o.environment AND pu.id=o.partner_unit_id
       LEFT JOIN LATERAL (
         SELECT p.id AS partner_purchase_id,p.receipt_status AS partner_receipt_status,
                COALESCE(sum(COALESCE(i.confirmed_quantity,i.quantity)),0)::int AS expected_units,
                COALESCE(sum(i.received_quantity),0)::int AS received_units
           FROM commerce.partner_purchases p
           LEFT JOIN commerce.partner_purchase_items i
             ON i.environment=p.environment AND i.purchase_id=p.id
          WHERE p.environment=o.environment AND p.source_wholesale_order_id=o.id
            AND p.deleted_at IS NULL
          GROUP BY p.id,p.receipt_status
       ) linked ON true
      WHERE o.environment=$1 ${periodWhere}
      ORDER BY o.sold_at DESC`,
    [environment],
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
  brand: string;
  tire_condition: TireCondition;
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

    const current = await client.query<{
      status: string; payment_status: string; partner_transfer_status: string | null;
    }>(
      `SELECT status,payment_status,partner_transfer_status FROM commerce.wholesale_orders
        WHERE id=$1 AND environment=$2 FOR UPDATE`, [input.order_id, environment]);
    if (!current.rows[0]) throw new Error('sale_not_found');
    if (current.rows[0].status !== 'confirmed') throw new Error('sale_already_cancelled');
    if (current.rows[0].partner_transfer_status) {
      throw new Error('matrix_partner_transfer_requires_arrival_adjustment');
    }
    const activeAdditions = await client.query<{ id: string }>(
      `SELECT id FROM commerce.wholesale_orders
        WHERE environment=$1 AND parent_order_id=$2 AND status='confirmed'
        ORDER BY sold_at,id LIMIT 1 FOR UPDATE`,
      [environment, input.order_id],
    );
    if (activeAdditions.rows[0]) throw new Error('sale_has_active_additions');
    await cancelLinkedPartnerPurchase(
      client, environment, input.order_id, input.cancelled_by, reason,
    );
    const ledgerState = env.MATRIZ_CENTRAL_LEDGER
      ? await getWholesaleSaleLedgerState(client, environment, input.order_id) : null;

    const history = await client.query<{
      measure: string; brand: string; tire_condition: TireCondition;
      returned_quantity: number; unverified_quantity: number;
    }>(
      `WITH nominal AS (
         SELECT measure,brand,tire_condition,sum(quantity)::int AS quantity
           FROM commerce.wholesale_order_items
          WHERE environment=$1 AND order_id=$2 GROUP BY measure,brand,tire_condition
       ), filmed AS (
         SELECT measure,brand,tire_condition,(-sum(qty_delta))::int AS quantity
           FROM commerce.wholesale_stock_movements
          WHERE environment=$1 AND source='venda_atacado' AND ref=$2::text AND qty_delta<0
          GROUP BY measure,brand,tire_condition HAVING -sum(qty_delta)>0
       )
       SELECT n.measure,n.brand,n.tire_condition,
              LEAST(n.quantity,COALESCE(f.quantity,0))::int AS returned_quantity,
              GREATEST(n.quantity-COALESCE(f.quantity,0),0)::int AS unverified_quantity
         FROM nominal n LEFT JOIN filmed f USING (measure,brand,tire_condition)
        ORDER BY n.measure,n.brand,n.tire_condition`,
      [environment, input.order_id]);
    const stockReturned = history.rows
      .filter((row) => row.returned_quantity > 0)
      .map((row) => ({
        measure: row.measure, brand: row.brand, tire_condition: row.tire_condition,
        quantity: row.returned_quantity,
      }));
    const stockUnverified = history.rows
      .filter((row) => row.unverified_quantity > 0)
      .map((row) => ({
        measure: row.measure, brand: row.brand, tire_condition: row.tire_condition,
        quantity: row.unverified_quantity,
      }));
    if (stockReturned.length === 0) {
      throw new Error(`sale_stock_history_missing:${JSON.stringify(stockUnverified)}`);
    }
    await applyWholesaleStockReturn(client, environment, stockReturned, true, input.order_id);

    const updated = await client.query<{ cancelled_at: string }>(
      `UPDATE commerce.wholesale_orders
          SET status='cancelled',cancelled_at=now(),cancelled_by=$3,cancel_reason=$4
        WHERE id=$1 AND environment=$2 RETURNING cancelled_at`,
      [input.order_id, environment, input.cancelled_by, reason.slice(0, 300)]);
    if (ledgerState) await postWholesaleSaleCancellation(client, ledgerState, stockReturned,
      updated.rows[0]!.cancelled_at, input.cancelled_by, reason);
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
