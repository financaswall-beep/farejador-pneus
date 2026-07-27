import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  ensureMatrizExpenseAccrual, getMatrizExpenseLedgerState,
  postMatrizExpensePayment, postMatrizExpenseRemoval,
} from './matriz-ledger-expenses.js';
import { reconcileMatrizMarketingSpend } from '../../marketing/matriz-ledger-spend.js';

type Environment = 'prod' | 'test';

export interface MatrizStage4Reconciliation {
  enabled: boolean;
  status: 'green' | 'yellow' | 'red';
  errors: {
    expense_accrual_missing: number;
    expense_payment_missing: number;
    expense_remove_missing: number;
    receipt_expense_missing: number;
    marketing_spend_mismatch: number;
    marketing_currency_unsupported: number;
  };
  pending_operational: { fuel_notes_without_approved_receipt: number };
  total_errors: number;
}

export async function getMatrizStage4LedgerReconciliation(
  environment: Environment = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizStage4Reconciliation> {
  const result = await dbPool.query<{
    expense_accrual_missing: number; expense_payment_missing: number;
    expense_remove_missing: number; receipt_expense_missing: number;
    marketing_spend_mismatch: number; marketing_currency_unsupported: number;
    fuel_notes_without_approved_receipt: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM commerce.matriz_expenses e
         WHERE e.environment=$1 AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=e.environment
              AND t.source_type='commerce.matriz_expense.accrual'
              AND t.source_id=e.id::text)) expense_accrual_missing,
       (SELECT count(*)::int FROM commerce.matriz_expenses e
         WHERE e.environment=$1 AND e.payment_status='paid'
           AND EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=e.environment
               AND t.source_type='commerce.matriz_expense.accrual'
               AND t.source_id=e.id::text AND t.transaction_kind='expense_payable')
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=e.environment
               AND t.source_type='commerce.matriz_expense.payment'
               AND t.source_id=e.id::text)) expense_payment_missing,
       (SELECT count(*)::int FROM commerce.matriz_expenses e
         WHERE e.environment=$1 AND e.deleted_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=e.environment
               AND t.source_type='commerce.matriz_expense.remove'
               AND t.source_id=e.id::text)) expense_remove_missing,
       (SELECT count(*)::int FROM commerce.matriz_trip_receipts r
         WHERE r.environment=$1 AND r.ai_expense_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=r.environment
               AND t.source_type='commerce.matriz_expense.accrual'
               AND t.source_id=r.ai_expense_id::text)) receipt_expense_missing,
       (SELECT count(*)::int FROM marketing.meta_insights_daily i
         WHERE i.environment=$1 AND i.entity_level='campaign'
           AND i.account_currency='BRL' AND abs(i.spend-COALESCE((
             SELECT sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)
               FROM finance.matriz_ledger_transactions t
               JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
              WHERE t.environment=i.environment
                AND t.source_type='marketing.meta_spend.adjustment'
                AND t.metadata->>'insight_id'=i.id::text
                AND e.account_code='marketing_expense'),0))>0.009)
         marketing_spend_mismatch,
       (SELECT count(*)::int FROM marketing.meta_insights_daily i
         WHERE i.environment=$1 AND i.entity_level='campaign' AND i.spend>0
           AND i.account_currency<>'BRL') marketing_currency_unsupported,
       (SELECT count(*)::int FROM commerce.matriz_delivery_trips t
         WHERE t.environment=$1 AND COALESCE(t.fuel_spent,0)>0
           AND NOT EXISTS (SELECT 1 FROM commerce.matriz_trip_receipts r
             WHERE r.environment=t.environment AND r.trip_id=t.id
               AND r.workflow_status IN ('linked','legacy_linked')))
         fuel_notes_without_approved_receipt`,
    [environment],
  );
  const row = result.rows[0]!;
  const errors = {
    expense_accrual_missing: row.expense_accrual_missing,
    expense_payment_missing: row.expense_payment_missing,
    expense_remove_missing: row.expense_remove_missing,
    receipt_expense_missing: row.receipt_expense_missing,
    marketing_spend_mismatch: row.marketing_spend_mismatch,
    marketing_currency_unsupported: row.marketing_currency_unsupported,
  };
  const total = Object.values(errors).reduce((sum, count) => sum + count, 0);
  const pending = row.fuel_notes_without_approved_receipt;
  return {
    enabled: env.MATRIZ_CENTRAL_LEDGER,
    status: total > 0 ? 'red' : pending > 0 ? 'yellow' : 'green',
    errors, pending_operational: { fuel_notes_without_approved_receipt: pending },
    total_errors: total,
  };
}

export async function runMatrizStage4LedgerBackfill(
  options: { environment?: Environment; limit?: number } = {},
  dbPool: Pool = defaultPool,
): Promise<{
  enabled: boolean; processed: { expenses: number; marketing: number };
  reconciliation: MatrizStage4Reconciliation;
}> {
  const environment = options.environment ?? env.FAREJADOR_ENV;
  const limit = Math.min(Math.max(1, options.limit ?? 500), 5_000);
  if (!env.MATRIZ_CENTRAL_LEDGER) return {
    enabled: false, processed: { expenses: 0, marketing: 0 },
    reconciliation: await getMatrizStage4LedgerReconciliation(environment, dbPool),
  };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const expenses = await client.query<{
      id: string; deleted_at: string | null; deleted_by: string | null;
      delete_reason: string | null;
    }>(
      `SELECT e.id,e.deleted_at,e.deleted_by,e.delete_reason
         FROM commerce.matriz_expenses e
        WHERE e.environment=$1 AND (
          NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=e.environment
              AND t.source_type='commerce.matriz_expense.accrual'
              AND t.source_id=e.id::text)
          OR (e.payment_status='paid' AND EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=e.environment
               AND t.source_type='commerce.matriz_expense.accrual'
               AND t.source_id=e.id::text AND t.transaction_kind='expense_payable')
            AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=e.environment
               AND t.source_type='commerce.matriz_expense.payment'
               AND t.source_id=e.id::text))
          OR (e.deleted_at IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=e.environment
               AND t.source_type='commerce.matriz_expense.remove'
               AND t.source_id=e.id::text))
        ) ORDER BY e.occurred_at,e.id LIMIT $2 FOR UPDATE OF e SKIP LOCKED`,
      [environment, limit],
    );
    for (const row of expenses.rows) {
      const expense = await getMatrizExpenseLedgerState(client, environment, row.id);
      const original = await client.query<{ transaction_kind: string }>(
        `SELECT transaction_kind FROM finance.matriz_ledger_transactions
          WHERE environment=$1 AND source_type='commerce.matriz_expense.accrual'
            AND source_id=$2`,
        [environment, row.id],
      );
      await ensureMatrizExpenseAccrual(client, expense);
      if (expense.paymentStatus === 'paid'
        && original.rows[0]?.transaction_kind === 'expense_payable') {
        await postMatrizExpensePayment(
          client, expense, expense.paidAt ?? expense.occurredAt, 'system:stage4-backfill',
        );
      }
      if (row.deleted_at) await postMatrizExpenseRemoval(
        client, expense, row.deleted_at, row.deleted_by ?? 'system:stage4-backfill',
        row.delete_reason ?? 'Remocao historica',
      );
    }
    const insights = await client.query<{ id: string; sync_run_id: string | null }>(
      `SELECT i.id,i.sync_run_id
         FROM marketing.meta_insights_daily i
        WHERE i.environment=$1 AND i.entity_level='campaign'
          AND i.account_currency='BRL' AND abs(i.spend-COALESCE((
            SELECT sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)
              FROM finance.matriz_ledger_transactions t
              JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
             WHERE t.environment=i.environment
               AND t.source_type='marketing.meta_spend.adjustment'
               AND t.metadata->>'insight_id'=i.id::text
               AND e.account_code='marketing_expense'),0))>0.009
        ORDER BY i.metric_date,i.id LIMIT $2 FOR UPDATE OF i SKIP LOCKED`,
      [environment, limit],
    );
    for (const insight of insights.rows) await reconcileMatrizMarketingSpend(
      client, insight.id, insight.sync_run_id ?? `backfill:${insight.id}`,
    );
    await client.query('COMMIT');
    return {
      enabled: true,
      processed: {
        expenses: expenses.rowCount ?? 0, marketing: insights.rowCount ?? 0,
      },
      reconciliation: await getMatrizStage4LedgerReconciliation(environment, dbPool),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
