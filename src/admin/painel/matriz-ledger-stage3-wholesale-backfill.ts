import type { PoolClient } from 'pg';
import {
  ensureWholesaleSaleCogs, ensureWholesaleSaleRevenue, getWholesaleSaleLedgerState,
  postWholesaleSaleCancellation, postWholesaleSalePayment,
} from './matriz-ledger-wholesale-sales.js';

type Environment = 'prod' | 'test';

export async function backfillWholesaleSales(
  client: PoolClient, environment: Environment, limit: number,
): Promise<number> {
  const rows = await client.query<{
    id: string; status: string; cancelled_at: string | null;
    cancelled_by: string | null; cancel_reason: string | null;
  }>(
    `SELECT o.id,o.status,o.cancelled_at,o.cancelled_by,o.cancel_reason
      FROM commerce.wholesale_orders o
      WHERE o.environment=$1 AND o.total_amount>0
        AND (
          ((o.partner_transfer_status IS NULL
              OR o.partner_transfer_status IN ('settled','received'))
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=o.environment AND t.source_id=o.id::text
                AND (
                  (o.partner_transfer_status IS NULL
                    AND t.source_type='commerce.wholesale_order.revenue')
                  OR (o.partner_transfer_status IN ('settled','received')
                    AND t.source_type IN ('commerce.wholesale_order.revenue',
                      'commerce.wholesale_order.arrival_revenue'))
                )))
          OR ((o.partner_transfer_status IS NULL
                OR o.partner_transfer_status IN ('settled','received'))
            AND EXISTS (SELECT 1 FROM commerce.wholesale_order_items i
                WHERE i.environment=o.environment AND i.order_id=o.id
                GROUP BY i.order_id HAVING sum((CASE
                  WHEN o.partner_transfer_status IN ('settled','received')
                    THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END)
                  *i.unit_cost)>0)
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=o.environment AND t.source_id=o.id::text
                AND (
                  (o.partner_transfer_status IS NULL
                    AND t.source_type='commerce.wholesale_order.cogs')
                  OR (o.partner_transfer_status IN ('settled','received')
                    AND t.source_type IN ('commerce.wholesale_order.cogs',
                      'commerce.wholesale_order.arrival_cogs'))
                )))
          OR (o.partner_transfer_status IS NULL AND o.status='cancelled' AND NOT EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment
               AND t.source_type='commerce.wholesale_order.revenue_cancel'
               AND t.source_id=o.id::text))
          OR (o.partner_transfer_status IS NULL AND o.status='cancelled' AND EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment
               AND t.source_type='commerce.wholesale_order.cogs'
               AND t.source_id=o.id::text)
            AND EXISTS (SELECT 1 FROM commerce.wholesale_stock_movements m
             WHERE m.environment=o.environment AND m.source='cancelamento_venda'
               AND m.ref=o.id::text AND m.qty_delta>0)
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment
               AND t.source_type='commerce.wholesale_order.cogs_cancel'
               AND t.source_id=o.id::text))
          OR ((o.partner_transfer_status IS NULL
                OR o.partner_transfer_status IN ('settled','received'))
            AND o.payment_status='paid' AND EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_id=o.id::text
               AND t.source_type IN ('commerce.wholesale_order.revenue',
                 'commerce.wholesale_order.arrival_revenue')
               AND t.transaction_kind='sale_receivable')
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_id=o.id::text
               AND t.source_type='commerce.wholesale_order.payment'))
        )
      ORDER BY o.sold_at,o.id LIMIT $2 FOR UPDATE OF o SKIP LOCKED`,
    [environment, limit],
  );
  for (const row of rows.rows) {
    const state = await getWholesaleSaleLedgerState(client, environment, row.id);
    const original = await client.query<{ transaction_kind: string }>(
      `SELECT transaction_kind FROM finance.matriz_ledger_transactions
        WHERE environment=$1 AND source_id=$2
          AND source_type IN ('commerce.wholesale_order.arrival_revenue',
            'commerce.wholesale_order.revenue')
        ORDER BY CASE source_type
          WHEN 'commerce.wholesale_order.arrival_revenue' THEN 0 ELSE 1 END
        LIMIT 1`,
      [environment, row.id],
    );
    await ensureWholesaleSaleRevenue(client, state);
    await ensureWholesaleSaleCogs(client, state);
    if (state.paymentStatus === 'paid'
      && original.rows[0]?.transaction_kind === 'sale_receivable') {
      await postWholesaleSalePayment(
        client, state, state.paidAt ?? state.soldAt, 'system:stage3-backfill',
      );
    }
    if (row.status === 'cancelled' && row.cancelled_at) {
      const returned = await client.query<{
        measure: string; brand: string;
        tire_condition: 'meia_vida' | 'novo' | 'remold'; quantity: number;
      }>(
        `SELECT measure,brand,tire_condition,sum(qty_delta)::int quantity
           FROM commerce.wholesale_stock_movements
          WHERE environment=$1 AND source='cancelamento_venda'
            AND ref=$2 AND qty_delta>0 GROUP BY measure,brand,tire_condition`,
        [environment, row.id],
      );
      await postWholesaleSaleCancellation(
        client, state, returned.rows, row.cancelled_at,
        row.cancelled_by ?? 'system:stage3-backfill',
        row.cancel_reason ?? 'Cancelamento historico',
      );
    }
  }
  return rows.rowCount ?? 0;
}
