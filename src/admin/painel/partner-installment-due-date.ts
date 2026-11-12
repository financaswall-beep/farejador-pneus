import type { PoolClient } from 'pg';
import { salePlanSnapshotSql } from './sale-payment-plan.js';

// A compra espelhada do parceiro guarda um vencimento. Após uma baixa parcial,
// ele passa a ser o primeiro vencimento que ainda tem saldo.
export async function syncPartnerInstallmentDueDate(client: PoolClient,
  environment: 'test' | 'prod', obligationId: string, orderId: string) {
  const next = await client.query<{ due_date: string }>(
    `SELECT (${salePlanSnapshotSql})->>'next_due' due_date
       FROM finance.matriz_ledger_transactions t WHERE environment=$1 AND id=$2`,
    [environment, obligationId]);
  const due = next.rows[0]?.due_date;
  if (!due) throw new Error('sale_installment_changed');
  await client.query(`UPDATE commerce.wholesale_orders SET due_date=$3::date
    WHERE environment=$1 AND id=$2 AND payment_status='pending'`, [environment, orderId, due]);
  const purchase = await client.query<{ id: string }>(
    `UPDATE commerce.partner_purchases SET payable_due_date=$3::date
      WHERE environment=$1 AND source_wholesale_order_id=$2 AND payment_status='payable'
        AND deleted_at IS NULL RETURNING id`, [environment, orderId, due]);
  if (!purchase.rows[0]) throw new Error('matrix_partner_payable_not_open');
  await client.query(`UPDATE finance.partner_payables SET due_date=$3::date, updated_at=now()
    WHERE environment=$1 AND source_purchase_id=$2 AND status='open' AND deleted_at IS NULL`,
    [environment, purchase.rows[0].id, due]);
}
