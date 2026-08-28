import type { PoolClient } from 'pg';
import {
  postMatrizLedgerTransaction,
  type MatrizLedgerAccountClass,
} from './matriz-ledger-posting.js';

export type SettlementEnvironment = 'prod' | 'test';

export interface SettlementObligationRow {
  id: string;
  source_type: string;
  source_id: string;
  account_code: string;
  account_class: MatrizLedgerAccountClass;
  open_amount: string;
}

const CENTRAL_ACCOUNTS = new Set([
  'supplier_refund_receivable', 'expense_refund_receivable',
  'customer_refund_payable',
]);

export async function recordSettlementPayment(
  client: PoolClient,
  environment: SettlementEnvironment,
  obligation: SettlementObligationRow,
  amount: number,
  paidAt: string,
  actor: string,
  sourceType: string,
  sourceId: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  const receivable = obligation.account_class === 'asset';
  const paymentId = await postMatrizLedgerTransaction(client, {
    environment, sourceType, sourceId, kind: 'payment', amount,
    occurredAt: paidAt, cashAt: paidAt,
    description: receivable ? 'Recebimento no Financeiro central' : 'Pagamento no Financeiro central',
    createdBy: actor,
    lines: receivable ? [
      { account_code: 'cash', account_class: 'asset', side: 'debit', amount },
      { account_code: obligation.account_code, account_class: 'asset', side: 'credit', amount },
    ] : [
      { account_code: obligation.account_code, account_class: 'liability', side: 'debit', amount },
      { account_code: 'cash', account_class: 'asset', side: 'credit', amount },
    ],
    metadata,
  });
  await client.query(
    `SELECT finance.record_matriz_ledger_payment(
       $1::env_t,$2,$3,$4::timestamptz,$5,NULL
     )`,
    [environment, obligation.id, paymentId, paidAt, actor],
  );
  return paymentId;
}

export async function lockSettlementObligation(
  client: PoolClient,
  environment: SettlementEnvironment,
  obligationId: string,
): Promise<SettlementObligationRow> {
  const result = await client.query<SettlementObligationRow>(
    `SELECT t.id,t.source_type,t.source_id,e.account_code,e.account_class,
            (e.amount-COALESCE((SELECT sum(CASE WHEN p.payment_kind IN ('settlement','writeoff','adjustment')
              THEN p.amount ELSE -p.amount END)
              FROM finance.matriz_ledger_payments p
             WHERE p.environment=t.environment
               AND p.obligation_transaction_id=t.id),0))::numeric(14,2)::text open_amount
       FROM finance.matriz_ledger_transactions t
       JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment=$1 AND t.id=$2
        AND (
          (e.account_code='accounts_receivable'
            AND e.account_class='asset' AND e.side='debit'
            AND t.source_type=ANY(ARRAY[
              'commerce.order.revenue',
              'commerce.wholesale_order.revenue',
              'commerce.wholesale_order.arrival_revenue'
            ]::text[]))
          OR (e.account_code='accounts_payable'
            AND e.account_class='liability' AND e.side='credit'
            AND t.source_type='commerce.wholesale_purchase.accrual')
          OR (e.account_code=ANY(ARRAY[
              'supplier_refund_receivable',
              'expense_refund_receivable',
              'customer_refund_payable'
            ]::text[])
            AND ((e.account_class='asset' AND e.side='debit')
              OR (e.account_class='liability' AND e.side='credit')))
        )
        AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
          WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)
      FOR UPDATE OF t`,
    [environment, obligationId],
  );
  const row = result.rows[0];
  const operational = row && (
    (row.account_code === 'accounts_receivable'
      && ['commerce.order.revenue','commerce.wholesale_order.revenue',
        'commerce.wholesale_order.arrival_revenue'].includes(row.source_type))
    || (row.account_code === 'accounts_payable'
      && row.source_type === 'commerce.wholesale_purchase.accrual')
  );
  if (!row || (!CENTRAL_ACCOUNTS.has(row.account_code) && !operational)) {
    throw new Error('central_obligation_not_actionable');
  }
  if (Number(row.open_amount) <= 0) throw new Error('central_obligation_not_open');
  return row;
}
