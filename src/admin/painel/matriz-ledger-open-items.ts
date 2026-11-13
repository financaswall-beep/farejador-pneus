import { salePlanSnapshotSql } from './sale-payment-plan.js';
import { purchaseInstallmentBalancesSql } from './purchase-installment-balances.js';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { moneyCents } from './stage5-integrity.js';
import { businessDateSaoPaulo } from '../../shared/business-time.js';

import type { MatrizLedgerOpenItems, FinanceiroReceivableItem, FinanceiroPayableItem, OpenRow } from './matriz-ledger-open-item-types.js';
export type { FinanceiroSettlementMode, MatrizLedgerOpenItems, FinanceiroReceivableItem, FinanceiroPayableItem } from './matriz-ledger-open-item-types.js';

const RECEIVABLE_ACCOUNTS = new Set([
  'accounts_receivable', 'network_commission_receivable',
  'network_monthly_fee_receivable', 'supplier_refund_receivable',
  'expense_refund_receivable',
]);

function moneyTotal(items: Array<{ valor: string }>): string {
  const cents = items.reduce((sum, item) => sum + moneyCents(Number(item.valor)), 0);
  return (cents / 100).toFixed(2);
}

function money(value: string | number): string {
  return (moneyCents(Number(value)) / 100).toFixed(2);
}

function receivable(row: OpenRow): FinanceiroReceivableItem {
  const base = {
    id: row.source_id, valor: money(row.balance),
    due_date: row.due_date, overdue: row.overdue,
    obligation_id: row.obligation_id, account_code: row.account_code,
  };
  if (row.account_code === 'network_monthly_fee_receivable') return {
    ...base, tipo: 'mensalidade', nome: row.partner_name ?? row.description,
    phone: row.partner_phone, settlement_mode: 'monthly_fee',
  };
  if (row.account_code === 'supplier_refund_receivable') return {
    ...base, tipo: 'devolucao_fornecedor',
    nome: row.supplier_name ?? row.description, phone: null,
    settlement_mode: 'central_obligation',
  };
  if (row.account_code === 'expense_refund_receivable') return {
    ...base, tipo: 'devolucao_despesa', nome: row.description, phone: null,
    categoria: row.category ?? undefined, settlement_mode: 'central_obligation',
  };
  if (row.source_type === 'finance.service_receivable') return {
    ...base,tipo:'servico',nome:row.description,phone:null,settlement_mode:'central_obligation',
  };
  const retail = row.source_type === 'commerce.order.revenue';
  return {
    ...base, tipo: retail ? 'varejo' : 'fiado',
    ...(row.sale_plan ? { sale_installment: row.installment_number, order_id: row.order_id } : {}),
    nome: row.sale_plan ? `${row.customer_name ?? row.description} · parcela ${row.installment_number}/${row.installments_count}`
      : retail ? row.description : (row.customer_name ?? row.description),
    phone: retail ? null : row.customer_phone,
    settlement_mode: retail ? 'retail_sale' : 'wholesale_sale',
  };
}

function payable(row: OpenRow): FinanceiroPayableItem {
  const base = {
    id: row.source_id, valor: money(row.balance),
    due_date: row.due_date, overdue: row.overdue,
    obligation_id: row.obligation_id, account_code: row.account_code,
  };
  if (row.account_code === 'commission_refund_payable') return {
    ...base, tipo: 'estorno_comissao',
    nome: `Devolução de comissão · ${row.partner_name ?? row.description}`,
    categoria: 'estorno_comissao', settlement_mode: 'commission_refund',
  };
  if (row.account_code === 'customer_refund_payable') return {
    ...base, tipo: 'devolucao_cliente', nome: row.description,
    categoria: 'devolucao_cliente', settlement_mode: 'central_obligation',
  };
  if (row.source_type === 'commerce.wholesale_purchase.accrual') return {
    ...base, tipo: 'fornecedor',
    ...(row.installment_number ? { parcela_compra: row.installment_number } : {}),
    nome: row.installment_number
      ? `${row.supplier_name ?? row.description} · parcela ${row.installment_number}/${row.installments_count}`
      : row.supplier_name ?? row.description,
    settlement_mode: 'wholesale_purchase',
  };
  if (row.source_type === 'finance.recurring_expense') return {
    ...base,tipo:'despesa',nome:row.description,categoria:row.category ?? undefined,settlement_mode:'central_obligation',
  };
  const payroll = row.category === 'funcionario';
  return {
    ...base, tipo: payroll ? 'folha' : 'despesa', nome: row.description,
    categoria: row.category ?? undefined, settlement_mode: 'expense',
  };
}

function sortAgenda<T extends { overdue: boolean; due_date: string | null; valor: string }>(
  items: T[],
): void {
  items.sort((a, b) => Number(b.overdue) - Number(a.overdue)
    || Number(Boolean(a.due_date)) - Number(Boolean(b.due_date))
    || String(a.due_date ?? '').localeCompare(String(b.due_date ?? ''))
    || moneyCents(Number(b.valor)) - moneyCents(Number(a.valor)));
}

export async function getMatrizLedgerOpenItems(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizLedgerOpenItems> {
  const result = await dbPool.query<OpenRow>(
    `WITH paid AS (
       SELECT obligation_transaction_id,
              sum(CASE WHEN payment_kind IN ('settlement','writeoff','adjustment')
                THEN amount ELSE -amount END) amount
         FROM finance.matriz_ledger_payments WHERE environment=$1
        GROUP BY obligation_transaction_id
     )
     SELECT ${salePlanSnapshotSql} AS sale_plan,t.id obligation_id,t.source_type,t.source_id,e.account_code,
            (e.amount-COALESCE(paid.amount,0))::numeric(14,2)::text balance,
            t.due_on::text due_date,
            (t.due_on IS NOT NULL
              AND t.due_on<(now() AT TIME ZONE 'America/Sao_Paulo')::date) overdue,
            t.description,t.metadata->>'category' category,
            t.metadata->>'partner_id' partner_id,
            COALESCE(np.trade_name,np.legal_name) partner_name,np.whatsapp_phone partner_phone,
            wc.name customer_name,wc.phone customer_phone,ws.name supplier_name
       FROM finance.matriz_ledger_transactions t
       JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
       LEFT JOIN paid ON paid.obligation_transaction_id=t.id
       LEFT JOIN network.partners np ON np.environment=t.environment
        AND np.id::text=t.metadata->>'partner_id'
       LEFT JOIN commerce.wholesale_orders wo ON wo.environment=t.environment
        AND wo.id::text=t.metadata->>'order_id'
       LEFT JOIN commerce.wholesale_customers wc ON wc.environment=wo.environment
        AND wc.id=wo.buyer_id
       LEFT JOIN commerce.wholesale_purchases wp ON wp.environment=t.environment
        AND wp.id::text=t.metadata->>'purchase_id'
       LEFT JOIN commerce.wholesale_suppliers ws ON ws.environment=wp.environment
        AND ws.id=wp.supplier_id
      WHERE t.environment=$1
        AND (NOT (t.metadata ? 'sale_plan') OR wo.status='confirmed')
        AND t.reversal_of_transaction_id IS NULL
        AND ((e.account_class='asset' AND e.side='debit'
              AND e.account_code=ANY($2::text[]))
          OR (e.account_class='liability' AND e.side='credit'
              AND e.account_code=ANY($3::text[])))
        AND e.account_code<>'marketing_payable'
        AND e.amount-COALESCE(paid.amount,0)>0
        AND NOT (e.account_code='commission_refund_payable' AND EXISTS (
          SELECT 1 FROM finance.matriz_ledger_transactions payment
           WHERE payment.environment=t.environment
             AND payment.source_type='network.commission_refund.payment'
             AND payment.source_id=t.source_id))
        AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
          WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)`,
    [environment, [...RECEIVABLE_ACCOUNTS], [
      'accounts_payable', 'commission_refund_payable', 'customer_refund_payable',
      'marketing_payable',
    ]],
  );
  const recebiveis: FinanceiroReceivableItem[] = [];
  const pagaveis: FinanceiroPayableItem[] = [];
  const commissions = new Map<string, FinanceiroReceivableItem>();
  const purchaseIds = result.rows
    .filter((row) => row.source_type === 'commerce.wholesale_purchase.accrual')
    .map((row) => row.source_id);
  const installmentRows = purchaseIds.length ? await dbPool.query<{
    purchase_id: string; installment_number: number; due_date: string; balance: string;
  }>(
    `SELECT p.id purchase_id,i.installment_number,i.due_date::text,i.balance::text
       FROM commerce.wholesale_purchases p CROSS JOIN LATERAL (${purchaseInstallmentBalancesSql}) i
      WHERE p.environment=$1 AND p.id=ANY($2::uuid[])
      ORDER BY p.id,i.installment_number`, [environment, purchaseIds],
  ) : { rows: [] };
  const installments = new Map<string, typeof installmentRows.rows>();
  for (const row of installmentRows.rows) {
    const list = installments.get(row.purchase_id) ?? [];
    list.push(row);
    installments.set(row.purchase_id, list);
  }
  const today = businessDateSaoPaulo(new Date());
  const expanded: OpenRow[] = [];
  for (const row of result.rows) {
    if (row.sale_plan) {
      for (const part of row.sale_plan.installments) {
        if (part.balance <= 0) continue;
        expanded.push({ ...row, order_id: row.source_id, source_id: `${row.source_id}:${part.number}`,
          balance: money(part.balance), due_date: part.due_date, overdue: part.due_date < today,
          installment_number: part.number, installments_count: row.sale_plan.installments.length });
      }
      continue;
    }
    const schedule = installments.get(row.source_id);
    if (!schedule?.length || row.source_type !== 'commerce.wholesale_purchase.accrual') {
      expanded.push(row);
      continue;
    }
    for (const installment of schedule) {
      const openCents = moneyCents(Number(installment.balance));
      if (openCents <= 0) continue;
      expanded.push({ ...row,
        source_id: `${row.source_id}:${installment.installment_number}`,
        balance: (openCents / 100).toFixed(2), due_date: installment.due_date,
        overdue: installment.due_date < today,
        installment_number: installment.installment_number,
        installments_count: schedule.length,
      });
    }
  }
  for (const row of expanded) {
    if (row.account_code === 'network_commission_receivable') {
      const id = row.partner_id ?? row.source_id;
      const current = commissions.get(id);
      if (current) {
        current.valor = ((moneyCents(Number(current.valor))
          + moneyCents(Number(row.balance))) / 100).toFixed(2);
        current.count = (current.count ?? 0) + 1;
      } else commissions.set(id, {
        tipo: 'comissao', id, nome: row.partner_name ?? row.description,
        valor: money(row.balance), due_date: null, overdue: false,
        phone: row.partner_phone, count: 1, settlement_mode: 'commission',
      });
    } else if (RECEIVABLE_ACCOUNTS.has(row.account_code)) recebiveis.push(receivable(row));
    else pagaveis.push(payable(row));
  }
  recebiveis.push(...commissions.values());
  const marketing = await dbPool.query<{ balance: string }>(
    `SELECT COALESCE(sum(CASE WHEN e.side='credit' THEN e.amount ELSE -e.amount END),0)
              ::numeric(14,2)::text balance
       FROM finance.matriz_ledger_entries e
      WHERE e.environment=$1 AND e.account_code='marketing_payable'`,
    [environment],
  );
  if (Number(marketing.rows[0]!.balance) > 0) pagaveis.push({
      tipo: 'marketing', id: 'marketing_payable', nome: 'Marketing · Anúncios',
    categoria: 'marketing', valor: money(marketing.rows[0]!.balance),
    due_date: null, overdue: false, account_code: 'marketing_payable',
    settlement_mode: 'central_account',
  });
  sortAgenda(recebiveis);
  sortAgenda(pagaveis);
  return {
    a_receber: { total: moneyTotal(recebiveis),
      vencidos_count: recebiveis.filter((item) => item.overdue).length, itens: recebiveis },
    a_pagar: { total: moneyTotal(pagaveis),
      vencidos_count: pagaveis.filter((item) => item.overdue).length, itens: pagaveis },
  };
}
