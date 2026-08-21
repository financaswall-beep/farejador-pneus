import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  ensureWholesalePurchaseAccrual, getWholesalePurchaseLedgerState,
  postWholesalePurchaseCancellation, postWholesalePurchasePayment,
  postWholesalePurchaseReceipt,
} from './matriz-ledger-purchases.js';
import { backfillWholesaleSales } from './matriz-ledger-stage3-wholesale-backfill.js';
import {
  postMatrizRetailCancellation, postMatrizRetailPaymentIfRealized,
  postMatrizRetailSaleFacts,
} from './matriz-ledger-retail-sales.js';
import { backfillMatrizInventoryAdjustmentPostings } from './matriz-ledger-inventory.js';
import {
  getMatrizStage3LedgerReconciliation, type MatrizStage3Reconciliation,
} from './matriz-ledger-stage3-report.js';
type Environment = 'prod' | 'test';
async function backfillPurchases(
  client: PoolClient, environment: Environment, limit: number,
): Promise<number> {
  const rows = await client.query<{
    id: string; status: string; cancelled_at: string | null;
    cancelled_by: string | null; cancel_reason: string | null;
    stock_applied_at: string | null;
  }>(
    `SELECT p.id,p.status,p.cancelled_at,p.cancelled_by,p.cancel_reason,p.stock_applied_at
       FROM commerce.wholesale_purchases p
      WHERE p.environment=$1 AND p.total_amount>0
        AND (
          NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=p.environment
              AND t.source_type='commerce.wholesale_purchase.accrual'
              AND t.source_id=p.id::text)
          OR (p.status='cancelled' AND NOT EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=p.environment
               AND t.source_type='commerce.wholesale_purchase.cancel'
               AND t.source_id=p.id::text))
          OR (p.payment_status='paid' AND EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=p.environment AND t.source_id=p.id::text
               AND t.source_type='commerce.wholesale_purchase.accrual'
               AND t.transaction_kind='purchase_payable')
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=p.environment AND t.source_id=p.id::text
               AND t.source_type='commerce.wholesale_purchase.payment'))
          OR (p.stock_applied AND EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
            JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
             WHERE t.environment=p.environment AND t.source_id=p.id::text
               AND t.source_type='commerce.wholesale_purchase.accrual'
               AND e.account_code='inventory_in_transit')
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=p.environment AND t.source_id=p.id::text
               AND t.source_type='commerce.wholesale_purchase.receipt'))
          OR (p.status='cancelled' AND EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions receipt
             WHERE receipt.environment=p.environment
               AND receipt.source_type='commerce.wholesale_purchase.receipt'
               AND receipt.source_id=p.id::text)
            AND EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions cancelled
             WHERE cancelled.environment=p.environment
               AND cancelled.source_type='commerce.wholesale_purchase.cancel'
               AND cancelled.source_id=p.id::text
               AND cancelled.reversal_of_transaction_id IS NOT NULL)
            AND NOT EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions receipt_cancel
             WHERE receipt_cancel.environment=p.environment
               AND receipt_cancel.source_type='commerce.wholesale_purchase.receipt_cancel'
               AND receipt_cancel.source_id=p.id::text))
        )
      ORDER BY p.purchased_at,p.id LIMIT $2 FOR UPDATE OF p SKIP LOCKED`,
    [environment, limit],
  );
  for (const row of rows.rows) {
    const state = await getWholesalePurchaseLedgerState(client, environment, row.id);
    const original = await client.query<{ transaction_kind: string; in_transit: boolean }>(
      `SELECT t.transaction_kind,EXISTS (
          SELECT 1 FROM finance.matriz_ledger_entries e
           WHERE e.transaction_id=t.id AND e.account_code='inventory_in_transit'
        ) in_transit
         FROM finance.matriz_ledger_transactions t
        WHERE t.environment=$1
          AND t.source_type='commerce.wholesale_purchase.accrual' AND t.source_id=$2`,
      [environment, row.id],
    );
    await ensureWholesalePurchaseAccrual(client, state);
    if (state.stockApplied && original.rows[0]?.in_transit) {
      await postWholesalePurchaseReceipt(
        client, state, row.stock_applied_at ?? state.purchasedAt, 'system:stage3-backfill',
      );
    }
    if (state.paymentStatus === 'paid'
      && original.rows[0]?.transaction_kind === 'purchase_payable') {
      await postWholesalePurchasePayment(
        client, state, state.paidAt ?? state.purchasedAt, 'system:stage3-backfill',
      );
    }
    if (row.status === 'cancelled' && row.cancelled_at) {
      await postWholesalePurchaseCancellation(
        client, state, row.cancelled_at, row.cancelled_by ?? 'system:stage3-backfill',
        row.cancel_reason ?? 'Cancelamento historico',
      );
    }
  }
  return rows.rowCount ?? 0;
}
async function backfillRetailSales(
  client: PoolClient, environment: Environment, limit: number,
): Promise<number> {
  const rows = await client.query<{
    id: string; status: string; updated_at: string; closed_by: string | null;
  }>(
    `SELECT o.id,o.status,o.updated_at,o.closed_by
       FROM commerce.orders o
       JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
      WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.total_amount>0
        AND o.status IN ('confirmed','paid','delivered','cancelled')
        AND (
          ((o.status<>'cancelled'
              OR EXISTS (SELECT 1 FROM audit.events a
                WHERE a.environment=o.environment AND a.entity_id=o.id
                  AND a.event_type='matriz_galpao_decrement')
              OR EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
                WHERE t.environment=o.environment AND t.source_id=o.id::text
                  AND t.source_type IN ('commerce.order.revenue','commerce.order.cogs'))
              OR EXISTS (SELECT 1 FROM commerce.order_items i
                WHERE i.environment=o.environment AND i.order_id=o.id
                  AND i.matriz_unit_cost IS NOT NULL))
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment AND t.source_type='commerce.order.revenue'
              AND t.source_id=o.id::text))
          OR (EXISTS (SELECT 1 FROM audit.events a
                WHERE a.environment=o.environment AND a.entity_id=o.id
                  AND a.event_type='matriz_galpao_decrement')
            AND EXISTS (SELECT 1 FROM commerce.order_items i
                WHERE i.environment=o.environment AND i.order_id=o.id
                GROUP BY i.order_id
                HAVING COALESCE(sum(i.quantity*i.matriz_unit_cost)
                  FILTER (WHERE i.matriz_unit_cost IS NOT NULL),0)>0)
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=o.environment AND t.source_type='commerce.order.cogs'
                AND t.source_id=o.id::text))
          OR (o.status='cancelled' AND EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment
               AND t.source_type='commerce.order.revenue'
               AND t.source_id=o.id::text)
            AND NOT EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment
               AND t.source_type='commerce.order.revenue_cancel'
               AND t.source_id=o.id::text))
          OR (o.status<>'cancelled' AND o.payment_method IS NOT NULL
            AND lower(btrim(o.payment_method))<>'a receber'
            AND ((o.fulfillment_mode='delivery' AND o.delivery_status='delivered')
              OR (o.fulfillment_mode<>'delivery'
                AND o.status IN ('confirmed','paid','delivered')))
            AND EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_type='commerce.order.revenue'
               AND t.source_id=o.id::text AND t.transaction_kind='sale_receivable')
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_type='commerce.order.payment'
               AND t.source_id=o.id::text))
          OR (o.status='cancelled' AND EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_type='commerce.order.cogs'
               AND t.source_id=o.id::text)
            AND EXISTS (SELECT 1 FROM audit.events a
             WHERE a.environment=o.environment AND a.entity_id=o.id
               AND a.event_type='matriz_galpao_return')
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment
               AND t.source_type='commerce.order.cogs_cancel'
               AND t.source_id=o.id::text))
        )
      ORDER BY o.created_at,o.id LIMIT $2 FOR UPDATE OF o SKIP LOCKED`,
    [environment, limit],
  );
  for (const row of rows.rows) {
    await postMatrizRetailSaleFacts(client, environment, row.id);
    await postMatrizRetailPaymentIfRealized(
      client, environment, row.id, 'system:stage3-backfill',
    );
    if (row.status === 'cancelled') {
      await postMatrizRetailCancellation(
        client, environment, row.id, row.updated_at,
        row.closed_by ?? 'system:stage3-backfill', 'Cancelamento historico',
      );
    }
  }
  return rows.rowCount ?? 0;
}
export async function runMatrizStage3LedgerBackfill(
  options: { environment?: Environment; limit?: number } = {},
  dbPool: Pool = defaultPool,
): Promise<{ enabled: boolean; processed: Record<string, number>; reconciliation: MatrizStage3Reconciliation }> {
  const environment = options.environment ?? env.FAREJADOR_ENV;
  const limit = Math.min(Math.max(1, options.limit ?? 500), 5_000);
  if (!env.MATRIZ_CENTRAL_LEDGER) {
    return { enabled: false, processed: {}, reconciliation:
      await getMatrizStage3LedgerReconciliation(environment, dbPool) };
  }
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const processed = {
      purchases: await backfillPurchases(client, environment, limit),
      wholesale_sales: await backfillWholesaleSales(client, environment, limit),
      retail_sales: await backfillRetailSales(client, environment, limit),
      inventory_adjustments:
        await backfillMatrizInventoryAdjustmentPostings(client, environment, limit),
    };
    await client.query('COMMIT');
    return { enabled: true, processed,
      reconciliation: await getMatrizStage3LedgerReconciliation(environment, dbPool) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
