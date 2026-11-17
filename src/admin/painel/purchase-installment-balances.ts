import type { PoolClient } from 'pg';
// A compra externa tem o alias p. Baixas antigas sem número mantêm a ordem original.
// Uma devolução parcial de mercadoria pode reduzir ou retirar parcelas do cronograma.
export const purchaseInstallmentBalancesSql = `
  WITH payments AS (
    SELECT (COALESCE(original_tx.metadata,tx.metadata)->>'purchase_installment')::int number,
           sum(CASE WHEN pay.payment_kind='reversal' THEN -pay.amount ELSE pay.amount END) paid
    FROM finance.matriz_ledger_transactions obligation
    JOIN finance.matriz_ledger_payments pay ON pay.environment=obligation.environment
      AND pay.obligation_transaction_id=obligation.id
    JOIN finance.matriz_ledger_transactions tx ON tx.id=pay.payment_transaction_id
    LEFT JOIN finance.matriz_ledger_payments original ON original.id=pay.reversal_of_payment_id
    LEFT JOIN finance.matriz_ledger_transactions original_tx ON original_tx.id=original.payment_transaction_id
    WHERE obligation.environment=p.environment AND obligation.source_type='commerce.wholesale_purchase.accrual'
      AND obligation.source_id=p.id::text AND pay.payment_kind IN ('settlement','reversal')
    GROUP BY 1
  ), parts AS (
    SELECT i.installment_number,i.due_date,i.amount,
      LEAST(i.amount,COALESCE(payments.paid,0)) applied
    FROM commerce.wholesale_purchase_installments i LEFT JOIN payments ON payments.number=i.installment_number
    WHERE i.environment=p.environment AND i.purchase_id=p.id
  ), unassigned AS (
    SELECT COALESCE((SELECT sum(paid) FROM payments),0)-COALESCE((SELECT sum(applied) FROM parts),0) paid
  )
  SELECT installment_number,due_date,amount,
    GREATEST(0,LEAST(amount-applied,sum(amount-applied) OVER (ORDER BY installment_number)-unassigned.paid)) balance
  FROM parts CROSS JOIN unassigned`;

export async function purchaseSchedule(client: PoolClient, environment: string, purchaseId: string) {
  return (await client.query<{installment_number:number; due_date:string; amount:string; balance:string}>(
    `SELECT s.installment_number,s.due_date::text,s.amount::text,s.balance::text
     FROM commerce.wholesale_purchases p CROSS JOIN LATERAL (${purchaseInstallmentBalancesSql}) s
     WHERE p.environment=$1 AND p.id=$2 ORDER BY s.installment_number`, [environment,purchaseId],
  )).rows;
}

/** Histórico e baixa usam os mesmos saldos. A compra externa tem o alias p. */
export const purchasePaymentDetailSql = `
  (SELECT COALESCE(-sum(m.delta),0)::text FROM finance.supplier_advance_movements m
    WHERE m.environment=p.environment AND m.purchase_id=p.id) AS credit_applied,
  CASE WHEN p.status='cancelled' OR p.payment_status='paid' THEN '0.00'
    ELSE COALESCE((SELECT finance.matriz_ledger_obligation_balance(p.environment,t.id)
      FROM finance.matriz_ledger_transactions t WHERE t.environment=p.environment
      AND t.source_type='commerce.wholesale_purchase.accrual' AND t.source_id=p.id::text),p.total_amount)::text END AS remaining_balance,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'number',s.installment_number,
    'due_date',s.due_date,'amount',s.amount,'balance',s.balance) ORDER BY s.installment_number)
    FROM (${purchaseInstallmentBalancesSql}) s JOIN commerce.wholesale_purchase_installments i
      ON i.environment=p.environment AND i.purchase_id=p.id AND i.installment_number=s.installment_number),'[]') AS installments`;
