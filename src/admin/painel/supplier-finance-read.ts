import type {Pool} from 'pg';
import {pool} from '../../persistence/db.js';
import {env} from '../../shared/config/env.js';
import {purchaseInstallmentBalancesSql} from './purchase-installment-balances.js';

type Reader=Pick<Pool,'query'>;
const owed=`SELECT p.supplier_id,p.id purchase_id,t.id obligation_id,p.purchased_at,p.due_date,p.total_amount,
  finance.matriz_ledger_obligation_balance(p.environment,t.id) balance
 FROM commerce.wholesale_purchases p JOIN finance.matriz_ledger_transactions t ON t.environment=p.environment
 AND t.source_type='commerce.wholesale_purchase.accrual' AND t.source_id=p.id::text AND t.transaction_kind='purchase_payable'
 WHERE p.environment=$1 AND p.status<>'cancelled' AND p.payment_status='pending'`;
export async function supplierFinanceSummary(db:Reader=pool,environment=env.FAREJADOR_ENV){
  return (await db.query(`WITH debt AS (${owed}), credits AS (
    SELECT supplier_id,sum(delta) available FROM finance.supplier_advance_movements WHERE environment=$1 GROUP BY supplier_id
  ), recoverable AS (
    SELECT p.supplier_id,sum(greatest(0,e.amount-COALESCE(pay.amount,0))) recoverable
    FROM commerce.wholesale_purchases p JOIN finance.matriz_ledger_transactions t ON t.environment=p.environment
    AND t.source_id=p.id::text AND t.source_type IN ('commerce.wholesale_purchase.adjustment','commerce.wholesale_purchase.cancel')
    JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id AND e.account_code='supplier_refund_receivable' AND e.side='debit'
    LEFT JOIN LATERAL(SELECT sum(CASE WHEN payment_kind='reversal' THEN -amount ELSE amount END) amount
      FROM finance.matriz_ledger_payments WHERE environment=$1 AND obligation_transaction_id=t.id) pay ON true
    WHERE p.environment=$1 AND NOT EXISTS(SELECT FROM finance.matriz_ledger_transactions r WHERE r.environment=$1 AND r.reversal_of_transaction_id=t.id)
    GROUP BY p.supplier_id
  ) SELECT s.id,s.name,s.deleted_at IS NOT NULL archived,coalesce(d.balance,0)::text payable,
    coalesce(c.available,0)::text available,coalesce(r.recoverable,0)::text recoverable FROM commerce.wholesale_suppliers s
    LEFT JOIN (SELECT supplier_id,sum(balance) balance FROM debt GROUP BY supplier_id) d ON d.supplier_id=s.id
    LEFT JOIN credits c ON c.supplier_id=s.id LEFT JOIN recoverable r ON r.supplier_id=s.id
    WHERE s.environment=$1 ORDER BY s.name,s.id`,[environment])).rows;
}
export async function supplierFinanceDetail(id:string,db:Reader=pool,environment=env.FAREJADOR_ENV){
  const args=[environment,id];
  const supplier=(await db.query('SELECT id,name,document,phone,notes,deleted_at IS NOT NULL archived FROM commerce.wholesale_suppliers WHERE environment=$1 AND id=$2',args)).rows[0];
  if(!supplier)throw Error('Fornecedor não encontrado.');
  const credits=(await db.query(`SELECT advance_id id,sum(delta)::text available,max(amount) FILTER(WHERE source_type='finance.supplier_advance.issue')::text amount,
    min(competence_on)::text AS day FROM finance.supplier_advance_movements WHERE environment=$1 AND supplier_id=$2 GROUP BY advance_id ORDER BY day DESC,advance_id`,args)).rows;
  const payables=(await db.query(`WITH debt AS (${owed} AND p.supplier_id=$2)
    SELECT d.purchase_id,d.obligation_id,d.purchased_at,d.total_amount,s.installment_number,
      COALESCE(s.due_date,d.due_date)::text due,least(d.balance,coalesce(s.balance,d.balance))::text balance
    FROM debt d JOIN commerce.wholesale_purchases p ON p.id=d.purchase_id AND p.environment=$1
    LEFT JOIN LATERAL (${purchaseInstallmentBalancesSql}) s ON true
    WHERE d.balance>0 AND coalesce(s.balance,d.balance)>0 ORDER BY due NULLS LAST,d.purchase_id,s.installment_number`,args)).rows;
  const movements=(await db.query(`SELECT m.id,m.advance_id,m.purchase_id,m.source_type,m.amount,m.description,m.competence_on::text AS day,m.metadata,
    EXISTS(SELECT FROM finance.matriz_ledger_transactions r WHERE r.environment=$1 AND r.reversal_of_transaction_id=m.id) reversed,
    ARRAY(SELECT digest FROM finance.supplier_advance_receipts a WHERE a.environment=m.environment AND a.advance_id=m.id ORDER BY created_at) receipts
    FROM finance.supplier_advance_movements m WHERE m.environment=$1 AND m.supplier_id=$2
    ORDER BY m.competence_on DESC,m.created_at DESC,m.id DESC`,args)).rows;
  const purchases=(await db.query(`SELECT p.id,p.purchased_at,p.total_amount,p.payment_status,p.status,p.purchase_kind
    FROM commerce.wholesale_purchases p WHERE p.environment=$1 AND p.supplier_id=$2 ORDER BY p.purchased_at DESC,p.id DESC`,args)).rows;
  const cash=(await db.query(`WITH obligations AS(SELECT t.id,t.source_id FROM finance.matriz_ledger_transactions t
    JOIN commerce.wholesale_purchases p ON p.environment=t.environment AND p.id::text=t.source_id
    WHERE t.environment=$1 AND p.supplier_id=$2 AND t.source_type IN ('commerce.wholesale_purchase.accrual','commerce.wholesale_purchase.cancel','commerce.wholesale_purchase.adjustment')),
    tx AS (SELECT id,source_id FROM obligations UNION SELECT pay.payment_transaction_id,o.source_id FROM obligations o
    JOIN finance.matriz_ledger_payments pay ON pay.environment=$1 AND pay.obligation_transaction_id=o.id)
    SELECT t.id,t.description,tx.source_id purchase_id,t.cash_on::text AS day,e.amount,e.side
    FROM tx JOIN finance.matriz_ledger_transactions t ON t.id=tx.id AND t.environment=$1
    JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id AND e.account_code='cash'
    WHERE t.cash_on IS NOT NULL ORDER BY t.cash_on DESC,t.created_at DESC`,args)).rows;
  const available = credits.reduce((cents,row)=>cents+Math.round(Number(row.available)*100),0)/100;
  return {supplier,credits,supplier_credit_available:available.toFixed(2),payables,movements,purchases,cash};
}
