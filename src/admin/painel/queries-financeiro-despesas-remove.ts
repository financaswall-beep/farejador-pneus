import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  getMatrizExpenseLedgerState, postMatrizExpenseRemoval,
} from './matriz-ledger-expenses.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, recordIntegrityEvent,
  operationFingerprint,
} from './stage5-integrity.js';
import type { MatrizWriteOptions } from './queries-financeiro-integridade.js';

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
    const current = await client.query<{
      amount: string; payment_status: string; deleted_at: string | null;
    }>(
      `SELECT amount,payment_status,deleted_at FROM commerce.matriz_expenses
        WHERE id=$1 AND environment=$2 FOR UPDATE`,
      [expenseId, environment],
    );
    if (!current.rows[0] || current.rows[0].deleted_at) throw new Error('expense_not_found');
    const expenseLedger = env.MATRIZ_CENTRAL_LEDGER
      ? await getMatrizExpenseLedgerState(client, environment, expenseId) : null;
    const removed = await client.query<{ id: string; deleted_at: string }>(
      `UPDATE commerce.matriz_expenses
          SET deleted_at=now(),deleted_by=$3,delete_reason=$4
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL RETURNING id,deleted_at`,
      [expenseId, environment, options.actor_label ?? null, reason.slice(0, 300)],
    );
    if (expenseLedger) await postMatrizExpenseRemoval(
      client, expenseLedger, removed.rows[0]!.deleted_at,
      options.actor_label, reason,
    );
    await recordIntegrityEvent(client, { environment, domain: 'matriz_expense',
      entityTable: 'commerce.matriz_expenses', entityId: expenseId,
      eventType: 'removed', actorLabel: options.actor_label,
      idempotencyKey: operation.idempotencyKey,
      before: {
        payment_status: current.rows[0].payment_status,
        amount: current.rows[0].amount,
      },
      after: { deleted: true, reason } });
    const result = { id: removed.rows[0]!.id };
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
