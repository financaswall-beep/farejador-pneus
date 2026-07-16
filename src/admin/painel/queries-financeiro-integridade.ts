import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { MatrizExpenseRow } from './queries-fiado-despesas.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult, moneyCents,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';

export interface MatrizWriteOptions {
  idempotency_key: string;
  actor_label?: string | null;
  reason?: string | null;
}

async function settleWholesalePayment(
  kind: 'order' | 'purchase',
  entityId: string,
  environment: 'prod' | 'test',
  dbPool: Pool,
  options: MatrizWriteOptions,
): Promise<{ id: string; paid_at: string }> {
  const client = await dbPool.connect();
  const sale = kind === 'order';
  const table = sale ? 'commerce.wholesale_orders' : 'commerce.wholesale_purchases';
  const domain = sale ? 'wholesale_sale.pay' : 'wholesale_purchase.pay';
  const operation = { environment, domain, idempotencyKey: options.idempotency_key,
    fingerprint: operationFingerprint({ id: entityId }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<{ id: string; paid_at: string }>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const activeStatus = sale ? `status='confirmed'` : `status<>'cancelled'`;
    const current = await client.query<{ payment_status: string; total_amount: string }>(
      `SELECT payment_status,total_amount FROM ${table}
        WHERE id=$1 AND environment=$2 AND ${activeStatus} FOR UPDATE`, [entityId, environment]);
    const notFound = sale ? 'receivable_not_found' : 'payable_not_found';
    if (!current.rows[0] || current.rows[0].payment_status !== 'pending') throw new Error(notFound);
    const paid = await client.query<{ id: string; paid_at: string }>(
      `UPDATE ${table} SET payment_status='paid',paid_at=now()
        WHERE id=$1 AND environment=$2 AND payment_status='pending' RETURNING id,paid_at`,
      [entityId, environment]);
    if (!paid.rows[0]) throw new Error(notFound);
    const result = integrityResult(paid.rows[0]!);
    await recordIntegrityEvent(client, { environment,
      domain: sale ? 'wholesale_sale' : 'wholesale_purchase', entityTable: table,
      entityId, eventType: 'payment_settled', actorLabel: options.actor_label,
      idempotencyKey: operation.idempotencyKey,
      before: { payment_status: 'pending', total_amount: current.rows[0].total_amount },
      after: { payment_status: 'paid', paid_at: result.paid_at } });
    await completeIntegrityOperation(client, operation, table, entityId, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function settleWholesaleOrderPayment(
  orderId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  options: MatrizWriteOptions,
): Promise<{ id: string; paid_at: string }> {
  return settleWholesalePayment('order', orderId, environment, dbPool, options);
}

export function settleWholesalePurchasePayment(
  purchaseId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  options: MatrizWriteOptions,
): Promise<{ id: string; paid_at: string }> {
  return settleWholesalePayment('purchase', purchaseId, environment, dbPool, options);
}

export interface CreateMatrizExpenseInput {
  category: string;
  description?: string | null;
  amount: number;
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
  created_by?: string | null;
  environment?: 'prod' | 'test';
  idempotency_key: string;
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
    }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<MatrizExpenseRow>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const created = await client.query<MatrizExpenseRow>(
      `INSERT INTO commerce.matriz_expenses
        (environment,category,description,amount,payment_status,due_date,paid_at,created_by)
       SELECT $1::env_t,$2,$3,$4,$5,$6::date,CASE WHEN $5='paid' THEN now() ELSE NULL END,$7
        WHERE EXISTS (SELECT 1 FROM commerce.matriz_expense_categories c
          WHERE c.environment=$1::env_t AND c.slug=$2 AND c.archived_at IS NULL)
       RETURNING id,category,description,amount,occurred_at,payment_status,due_date,paid_at,
         NULL::uuid AS payroll_item_id,
         (payment_status='pending' AND due_date IS NOT NULL AND due_date<current_date) AS overdue`,
      [environment, input.category, input.description?.trim() || null, input.amount,
       paymentStatus, paymentStatus === 'pending' ? (input.due_date ?? null) : null,
       input.created_by ?? null]);
    if (!created.rows[0]) throw new Error('category_invalid');
    const result = integrityResult(created.rows[0]);
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
    fingerprint: operationFingerprint({ id: expenseId }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<{ id: string; paid_at: string }>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const current = await lockExpense(client, expenseId, environment);
    if (!current || current.deleted_at || current.payment_status !== 'pending') throw new Error('expense_not_found');
    const payroll = await client.query<{
      id: string; payroll_period_id: string; payment_status: string;
    }>(
      `SELECT id,payroll_period_id,payment_status FROM finance.matriz_payroll_items
        WHERE environment=$1 AND source_expense_id=$2 FOR UPDATE`, [environment, expenseId]);
    if (payroll.rows[0] && payroll.rows[0].payment_status !== 'pending') {
      throw new Error('payroll_payment_conflict');
    }
    const paid = await client.query<{ id: string; paid_at: string }>(
      `UPDATE commerce.matriz_expenses SET payment_status='paid',paid_at=now()
        WHERE id=$1 AND environment=$2 RETURNING id,paid_at`, [expenseId, environment]);
    const result = integrityResult(paid.rows[0]!);
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
        payroll_item_id: payroll.rows[0]?.id ?? null } });
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

export async function removeMatrizExpense(
  expenseId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  options: MatrizWriteOptions,
): Promise<{ id: string }> {
  const reason = options.reason?.trim() || null;
  if (!reason || reason.length < 2) throw new Error('reason_required');
  const client = await dbPool.connect();
  const operation = { environment, domain: 'matriz_expense.remove',
    idempotencyKey: options.idempotency_key,
    fingerprint: operationFingerprint({ id: expenseId, reason }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<{ id: string }>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const current = await lockExpense(client, expenseId, environment);
    if (!current || current.deleted_at) throw new Error('expense_not_found');
    const removed = await client.query<{ id: string }>(
      `UPDATE commerce.matriz_expenses
          SET deleted_at=now(),deleted_by=$3,delete_reason=$4
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL RETURNING id`,
      [expenseId, environment, options.actor_label ?? null, reason.slice(0, 300)]);
    await recordIntegrityEvent(client, { environment, domain: 'matriz_expense',
      entityTable: 'commerce.matriz_expenses', entityId: expenseId,
      eventType: 'removed', actorLabel: options.actor_label,
      idempotencyKey: operation.idempotencyKey,
      before: { payment_status: current.payment_status, amount: current.amount },
      after: { deleted: true, reason } });
    await completeIntegrityOperation(client, operation,
      'commerce.matriz_expenses', expenseId, removed.rows[0]);
    await client.query('COMMIT');
    return removed.rows[0]!;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
