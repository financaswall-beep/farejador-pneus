import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import {
  matrizLedgerActor, matrizLedgerAmount, postMatrizLedgerTransaction,
} from './matriz-ledger-posting.js';

export interface MatrizExpenseLedgerState {
  environment: 'prod' | 'test';
  expenseId: string;
  category: string;
  description: string | null;
  amount: string | number;
  occurredAt: string;
  paymentStatus: 'paid' | 'pending';
  dueDate: string | null;
  paidAt: string | null;
  createdBy: string | null;
  competenceMonth?: string | null;
  documentDate?: string | null;
}

export async function getMatrizExpenseLedgerState(
  client: PoolClient,
  environment: 'prod' | 'test',
  expenseId: string,
): Promise<MatrizExpenseLedgerState> {
  const result = await client.query<{
    category: string; description: string | null; amount: string; occurred_at: string;
    payment_status: 'paid' | 'pending'; due_date: string | null;
    paid_at: string | null; created_by: string | null;
    competence_month: string | null; document_date: string | null;
  }>(
    `SELECT category,description,amount,occurred_at,payment_status,due_date,
            paid_at,created_by,competence_month,document_date
       FROM commerce.matriz_expenses WHERE environment=$1 AND id=$2`,
    [environment, expenseId],
  );
  if (!result.rows[0]) throw new Error('expense_not_found');
  const row = result.rows[0];
  return {
    environment, expenseId, category: row.category, description: row.description,
    amount: row.amount, occurredAt: row.occurred_at,
    paymentStatus: row.payment_status, dueDate: row.due_date,
    paidAt: row.paid_at, createdBy: row.created_by,
    competenceMonth: row.competence_month, documentDate: row.document_date,
  };
}

function expenseAccount(category: string): string {
  return `expense_${category}`;
}

export async function ensureMatrizExpenseAccrual(
  client: PoolClient,
  expense: MatrizExpenseLedgerState,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const amount = matrizLedgerAmount(expense.amount, 'expense_ledger_amount_invalid');
  if (amount === 0) return null;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM finance.matriz_ledger_transactions
      WHERE environment=$1 AND source_type='commerce.matriz_expense.accrual'
        AND source_id=$2`,
    [expense.environment, expense.expenseId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const creditAccount = expense.paymentStatus === 'paid' ? 'cash' : 'accounts_payable';
  return postMatrizLedgerTransaction(client, {
    environment: expense.environment,
    sourceType: 'commerce.matriz_expense.accrual', sourceId: expense.expenseId,
    kind: expense.paymentStatus === 'paid' ? 'expense_cash' : 'expense_payable',
    amount, occurredAt: expense.occurredAt,
    dueDate: expense.paymentStatus === 'pending' ? expense.dueDate : null,
    cashAt: expense.paymentStatus === 'paid'
      ? (expense.paidAt ?? expense.occurredAt) : null,
    description: expense.description ?? `Despesa: ${expense.category}`,
    createdBy: matrizLedgerActor(expense.createdBy),
    lines: [
      {
        account_code: expenseAccount(expense.category),
        account_class: 'expense', side: 'debit', amount,
      },
      {
        account_code: creditAccount,
        account_class: creditAccount === 'cash' ? 'asset' : 'liability',
        side: 'credit', amount,
      },
    ],
    metadata: {
      expense_id: expense.expenseId, category: expense.category,
      competence_month: expense.competenceMonth ?? null,
      document_date: expense.documentDate ?? null,
    },
  });
}

export async function postMatrizExpensePayment(
  client: PoolClient,
  expense: MatrizExpenseLedgerState,
  paidAt: string,
  actorLabel?: string | null,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const amount = matrizLedgerAmount(expense.amount, 'expense_ledger_amount_invalid');
  const obligationId = await ensureMatrizExpenseAccrual(client, {
    ...expense, paymentStatus: 'pending', paidAt: null,
  });
  if (!obligationId || amount === 0) return null;
  const paymentId = await postMatrizLedgerTransaction(client, {
    environment: expense.environment,
    sourceType: 'commerce.matriz_expense.payment', sourceId: expense.expenseId,
    kind: 'payment', amount, occurredAt: paidAt, cashAt: paidAt,
    description: 'Pagamento de despesa da Matriz',
    createdBy: matrizLedgerActor(actorLabel),
    lines: [
      { account_code: 'accounts_payable', account_class: 'liability', side: 'debit', amount },
      { account_code: 'cash', account_class: 'asset', side: 'credit', amount },
    ],
    metadata: { expense_id: expense.expenseId, category: expense.category },
  });
  await client.query(
    `SELECT finance.record_matriz_ledger_payment(
       $1::env_t,$2,$3,$4::timestamptz,$5,NULL
     )`,
    [expense.environment, obligationId, paymentId, paidAt, matrizLedgerActor(actorLabel)],
  );
  return paymentId;
}

export async function postMatrizExpenseRemoval(
  client: PoolClient,
  expense: MatrizExpenseLedgerState,
  removedAt: string,
  actorLabel: string | null | undefined,
  reason: string,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const amount = matrizLedgerAmount(expense.amount, 'expense_ledger_amount_invalid');
  const originalId = await ensureMatrizExpenseAccrual(client, expense);
  if (!originalId || amount === 0) return null;
  if (expense.paymentStatus === 'pending') {
    const reversal = await client.query<{ id: string }>(
      `SELECT finance.reverse_matriz_ledger_transaction(
         $1::env_t,$2,'commerce.matriz_expense.remove',$3,
         ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
         $5,$6,NULL,$7::jsonb
       ) id`,
      [
        expense.environment, originalId, expense.expenseId, removedAt,
        'Remocao de despesa nao paga', matrizLedgerActor(actorLabel),
        JSON.stringify({ expense_id: expense.expenseId, reason }),
      ],
    );
    return reversal.rows[0]!.id;
  }
  return postMatrizLedgerTransaction(client, {
    environment: expense.environment,
    sourceType: 'commerce.matriz_expense.remove', sourceId: expense.expenseId,
    kind: 'expense_refund_receivable', amount, occurredAt: removedAt,
    description: 'Valor a recuperar por despesa paga removida',
    createdBy: matrizLedgerActor(actorLabel),
    lines: [
      {
        account_code: 'expense_refund_receivable',
        account_class: 'asset', side: 'debit', amount,
      },
      {
        account_code: expenseAccount(expense.category),
        account_class: 'expense', side: 'credit', amount,
      },
    ],
    metadata: { expense_id: expense.expenseId, category: expense.category, reason },
  });
}
