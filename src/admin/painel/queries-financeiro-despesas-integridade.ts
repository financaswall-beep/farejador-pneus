import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { ensureMatrizExpenseAccrual, getMatrizExpenseLedgerState, postMatrizExpensePayment } from './matriz-ledger-expenses.js';
import type { MatrizWriteOptions } from './queries-financeiro-integridade.js';
import type { MatrizExpenseRow } from './queries-fiado-despesas.js';
import { beginIntegrityOperation, completeIntegrityOperation, integrityResult, moneyCents, operationFingerprint, recordIntegrityEvent } from './stage5-integrity.js';

export interface CreateMatrizExpenseInput {
  category: string;
  description?: string | null;
  amount: number;
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
  paid_at?: string | null;
  occurred_at?: string | null;
  document_date?: string | null;
  competence_month?: string | null;
  created_by?: string | null;
  environment?: 'prod' | 'test';
  idempotency_key: string;
}
export interface MatrizExpenseTransactionInput {
  environment: 'prod' | 'test';
  category: string;
  description?: string | null;
  amount: number;
  payment_status: 'paid' | 'pending';
  due_date?: string | null;
  paid_at?: string | null;
  occurred_at?: string | null;
  document_date?: string | null;
  competence_month?: string | null;
  created_by?: string | null;
}

/** Núcleo sem BEGIN/COMMIT: permite que a aprovação do comprovante crie a
 * despesa na mesma transação da decisão. O chamador é dono do rollback. */
export async function insertMatrizExpenseInTransaction(
  client: PoolClient,
  input: MatrizExpenseTransactionInput,
): Promise<MatrizExpenseRow> {
  const created = await client.query<MatrizExpenseRow>(
    `INSERT INTO commerce.matriz_expenses
      (environment,category,description,amount,payment_status,due_date,paid_at,
       occurred_at,document_date,competence_month,created_by)
     SELECT $1::env_t,$2,$3,$4,$5,$6::date,
            CASE WHEN $5='paid' THEN COALESCE($7::timestamptz,now()) ELSE NULL END,
            COALESCE($8::timestamptz,now()),$9::date,$10::date,$11
      WHERE EXISTS (SELECT 1 FROM commerce.matriz_expense_categories c
        WHERE c.environment=$1::env_t AND c.slug=$2 AND c.archived_at IS NULL)
     RETURNING id,category,description,amount,occurred_at,payment_status,due_date,paid_at,
       NULL::uuid AS payroll_item_id,
       (payment_status='pending' AND due_date IS NOT NULL
        AND due_date<(now() AT TIME ZONE 'America/Sao_Paulo')::date) AS overdue`,
    [input.environment, input.category, input.description?.trim() || null, input.amount,
     input.payment_status, input.payment_status === 'pending' ? input.due_date ?? null : null,
     input.payment_status === 'paid' ? input.paid_at ?? null : null,
     input.occurred_at ?? null, input.document_date ?? null,
     input.competence_month ?? null, input.created_by ?? null],
  );
  if (!created.rows[0]) throw new Error('category_invalid');
  const expense = created.rows[0];
  await ensureMatrizExpenseAccrual(client, {
    environment: input.environment, expenseId: expense.id,
    category: expense.category, description: expense.description,
    amount: expense.amount, occurredAt: expense.occurred_at,
    paymentStatus: expense.payment_status, dueDate: expense.due_date,
    paidAt: expense.paid_at, createdBy: input.created_by ?? null,
    competenceMonth: input.competence_month, documentDate: input.document_date,
  });
  return expense;
}

export async function createMatrizExpense(
  input: CreateMatrizExpenseInput,
  dbPool: Pool = defaultPool,
): Promise<MatrizExpenseRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  const paymentStatus = input.payment_status ?? 'paid';
  const operation = { environment, domain: 'matriz_expense.create',
    idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint({
      category: input.category, description: input.description?.trim() || null,
      amount_cents: moneyCents(input.amount), payment_status: paymentStatus,
      due_date: paymentStatus === 'pending' ? (input.due_date ?? null) : null,
      paid_at: paymentStatus === 'paid' ? (input.paid_at ?? null) : null,
      occurred_at: input.occurred_at ?? null,
      document_date: input.document_date ?? null,
      competence_month: input.competence_month ?? null,
    }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<MatrizExpenseRow>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const created = await insertMatrizExpenseInTransaction(client, {
      environment, category: input.category, description: input.description,
      amount: input.amount, payment_status: paymentStatus,
      due_date: input.due_date, paid_at: input.paid_at,
      occurred_at: input.occurred_at, document_date: input.document_date,
      competence_month: input.competence_month, created_by: input.created_by,
    });
    const result = integrityResult(created);
    await recordIntegrityEvent(client, { environment, domain: 'matriz_expense',
      entityTable: 'commerce.matriz_expenses', entityId: result.id,
      eventType: 'created', actorLabel: input.created_by,
      idempotencyKey: operation.idempotencyKey, after: result });
    await completeIntegrityOperation(client, operation,
      'commerce.matriz_expenses', result.id, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockExpense(client: PoolClient, expenseId: string, environment: 'prod' | 'test') {
  const current = await client.query<{
    id: string; amount: string; payment_status: string; paid_at: string | null; deleted_at: string | null;
  }>(
    `SELECT id,amount,payment_status,paid_at,deleted_at FROM commerce.matriz_expenses
      WHERE id=$1 AND environment=$2 FOR UPDATE`, [expenseId, environment]);
  return current.rows[0];
}

export async function settleMatrizExpense(
  expenseId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  options: MatrizWriteOptions,
): Promise<{ id: string; paid_at: string }> {
  const client = await dbPool.connect();
  const operation = { environment, domain: 'matriz_expense.pay',
    idempotencyKey: options.idempotency_key,
    fingerprint: operationFingerprint({
      id: expenseId, paid_at: options.paid_at ?? null,
      payment_method: options.payment_method?.trim().toLowerCase() ?? null,
      cash_account: options.cash_account?.trim().toLowerCase() ?? null,
      note: options.note?.trim() || null,
    }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<{ id: string; paid_at: string }>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const current = await lockExpense(client, expenseId, environment);
    if (!current || current.deleted_at || current.payment_status !== 'pending') throw new Error('expense_not_found');
    const expenseLedger = env.MATRIZ_CENTRAL_LEDGER
      ? await getMatrizExpenseLedgerState(client, environment, expenseId) : null;
    const payroll = await client.query<{
      id: string; payroll_period_id: string; payment_status: string;
    }>(
      `SELECT id,payroll_period_id,payment_status FROM finance.matriz_payroll_items
        WHERE environment=$1 AND source_expense_id=$2 FOR UPDATE`, [environment, expenseId]);
    if (payroll.rows[0] && payroll.rows[0].payment_status !== 'pending') {
      throw new Error('payroll_payment_conflict');
    }
    const paidAt = options.paid_at ?? new Date().toISOString();
    const paid = await client.query<{ id: string; paid_at: string }>(
      `UPDATE commerce.matriz_expenses SET payment_status='paid',paid_at=$3::timestamptz
        WHERE id=$1 AND environment=$2 RETURNING id,paid_at`,
      [expenseId, environment, paidAt]);
    const result = integrityResult(paid.rows[0]!);
    if (expenseLedger) await postMatrizExpensePayment(
      client, expenseLedger, result.paid_at, options.actor_label, options,
    );
    if (payroll.rows[0]) {
      await client.query(
        `UPDATE finance.matriz_payroll_items
            SET payment_status='paid',paid_at=$2::timestamptz,paid_by=$3
          WHERE id=$1`, [payroll.rows[0].id, result.paid_at, options.actor_label ?? null]);
      await client.query(
        `UPDATE finance.matriz_payroll_periods SET status=CASE WHEN EXISTS
          (SELECT 1 FROM finance.matriz_payroll_items
            WHERE payroll_period_id=$1 AND payment_status='pending') THEN 'partial' ELSE 'paid' END
         WHERE id=$1`, [payroll.rows[0].payroll_period_id]);
    }
    await recordIntegrityEvent(client, { environment, domain: 'matriz_expense',
      entityTable: 'commerce.matriz_expenses', entityId: expenseId,
      eventType: 'payment_settled', actorLabel: options.actor_label,
      idempotencyKey: operation.idempotencyKey,
      before: { payment_status: 'pending', amount: current.amount },
      after: { payment_status: 'paid', paid_at: result.paid_at,
        payroll_item_id: payroll.rows[0]?.id ?? null,
        payment_method: options.payment_method?.trim() || null,
        cash_account: options.cash_account?.trim() || null,
        note: options.note?.trim() || null } });
    await completeIntegrityOperation(client, operation,
      'commerce.matriz_expenses', expenseId, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
