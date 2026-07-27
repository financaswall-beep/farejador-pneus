import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  ensureMatrizExpenseAccrual, getMatrizExpenseLedgerState,
  postMatrizExpensePayment,
} from './matriz-ledger-expenses.js';
import { sweepCommissionEntries } from './queries-comissoes.js';

type Environment = 'prod' | 'test';

export interface MatrizStage5Reconciliation {
  enabled: boolean;
  status: 'green' | 'yellow' | 'red';
  errors: {
    commission_accrual_missing: number;
    commission_payment_missing: number;
    commission_reversal_missing: number;
    commission_refund_payment_missing: number;
    monthly_fee_current_missing: number;
    monthly_fee_accrual_missing: number;
    monthly_fee_payment_missing: number;
    payroll_accrual_missing: number;
    payroll_payment_missing: number;
    payroll_source_mismatch: number;
  };
  pending_operational: { payroll_assignment_gaps_current_month: number };
  total_errors: number;
}

export async function getMatrizStage5LedgerReconciliation(
  environment: Environment = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizStage5Reconciliation> {
  const result = await dbPool.query<{
    commission_accrual_missing: number; commission_payment_missing: number;
    commission_reversal_missing: number; commission_refund_payment_missing: number;
    monthly_fee_current_missing: number; monthly_fee_accrual_missing: number;
    monthly_fee_payment_missing: number; payroll_accrual_missing: number;
    payroll_payment_missing: number; payroll_source_mismatch: number;
    payroll_assignment_gaps_current_month: number;
  }>(
    `WITH current_competence AS (
       SELECT date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date value
     )
     SELECT
       (SELECT count(*)::int FROM network.commission_entries ce
         WHERE ce.environment=$1 AND ce.commission_amount>0
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=ce.environment::env_t
               AND t.source_type='network.commission_entry.accrual'
               AND t.source_id=ce.id::text)) commission_accrual_missing,
       (SELECT count(*)::int FROM network.commission_entries ce
         WHERE ce.environment=$1 AND ce.commission_amount>0
           AND ce.settled_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=ce.environment::env_t
               AND t.source_type='network.commission_entry.payment'
               AND t.source_id=ce.id::text)) commission_payment_missing,
       (SELECT count(*)::int FROM finance.matriz_commission_reversals r
         WHERE r.environment=$1
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=r.environment
               AND t.source_type='network.commission_entry.reversal'
               AND t.source_id=r.id::text)) commission_reversal_missing,
       (SELECT count(*)::int FROM finance.matriz_commission_reversals r
         WHERE r.environment=$1 AND r.refund_status='paid'
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=r.environment
               AND t.source_type='network.commission_refund.payment'
               AND t.source_id=r.id::text)) commission_refund_payment_missing,
       (SELECT count(*)::int FROM network.partners p CROSS JOIN current_competence c
         WHERE p.environment=$1 AND p.deleted_at IS NULL AND p.status='active'
           AND p.commercial_model IN ('monthly','hybrid') AND p.monthly_fee>0
           AND p.created_at<(c.value+interval '1 month')
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_partner_monthly_fees f
             WHERE f.environment=p.environment::env_t AND f.partner_id=p.id
               AND f.competence=c.value)) monthly_fee_current_missing,
       (SELECT count(*)::int FROM finance.matriz_partner_monthly_fees f
         WHERE f.environment=$1
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=f.environment
               AND t.source_type='network.monthly_fee.accrual'
               AND t.source_id=f.id::text)) monthly_fee_accrual_missing,
       (SELECT count(*)::int FROM finance.matriz_partner_monthly_fees f
         WHERE f.environment=$1 AND f.status='settled'
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=f.environment
               AND t.source_type='network.monthly_fee.payment'
               AND t.source_id=f.id::text)) monthly_fee_payment_missing,
       (SELECT count(*)::int FROM finance.matriz_payroll_items i
         WHERE i.environment=$1
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=i.environment
               AND t.source_type='commerce.matriz_expense.accrual'
               AND t.source_id=i.source_expense_id::text)) payroll_accrual_missing,
       (SELECT count(*)::int FROM finance.matriz_payroll_items i
         WHERE i.environment=$1 AND i.payment_status='paid'
           AND EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=i.environment
               AND t.source_type='commerce.matriz_expense.accrual'
               AND t.source_id=i.source_expense_id::text
               AND t.transaction_kind='expense_payable')
           AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=i.environment
               AND t.source_type='commerce.matriz_expense.payment'
               AND t.source_id=i.source_expense_id::text)) payroll_payment_missing,
       (SELECT count(*)::int FROM finance.matriz_payroll_items i
         LEFT JOIN commerce.matriz_expenses e
           ON e.environment=i.environment AND e.id=i.source_expense_id
        WHERE i.environment=$1 AND (
          e.id IS NULL OR e.deleted_at IS NOT NULL OR e.category<>'funcionario'
          OR e.amount<>i.total_due OR e.payment_status<>i.payment_status
        )) payroll_source_mismatch,
       (SELECT COALESCE(sum(g.missing_count),0)::int
          FROM current_competence c
          CROSS JOIN LATERAL finance.matriz_payroll_assignment_gaps(
            $1::env_t,c.value) g) payroll_assignment_gaps_current_month`,
    [environment],
  );
  const row = result.rows[0]!;
  const errors = {
    commission_accrual_missing: row.commission_accrual_missing,
    commission_payment_missing: row.commission_payment_missing,
    commission_reversal_missing: row.commission_reversal_missing,
    commission_refund_payment_missing: row.commission_refund_payment_missing,
    monthly_fee_current_missing: row.monthly_fee_current_missing,
    monthly_fee_accrual_missing: row.monthly_fee_accrual_missing,
    monthly_fee_payment_missing: row.monthly_fee_payment_missing,
    payroll_accrual_missing: row.payroll_accrual_missing,
    payroll_payment_missing: row.payroll_payment_missing,
    payroll_source_mismatch: row.payroll_source_mismatch,
  };
  const total = Object.values(errors).reduce((sum, count) => sum + count, 0);
  const pending = row.payroll_assignment_gaps_current_month;
  return {
    enabled: env.MATRIZ_CENTRAL_LEDGER,
    status: total > 0 ? 'red' : pending > 0 ? 'yellow' : 'green',
    errors,
    pending_operational: { payroll_assignment_gaps_current_month: pending },
    total_errors: total,
  };
}

export async function runMatrizStage5LedgerBackfill(
  options: { environment?: Environment; limit?: number } = {},
  dbPool: Pool = defaultPool,
): Promise<{
  enabled: boolean;
  processed: { commissions_created: number; commissions_reversed: number; payroll: number };
  reconciliation: MatrizStage5Reconciliation;
}> {
  const environment = options.environment ?? env.FAREJADOR_ENV;
  const limit = Math.min(Math.max(1, options.limit ?? 500), 5_000);
  if (!env.MATRIZ_CENTRAL_LEDGER) return {
    enabled: false,
    processed: { commissions_created: 0, commissions_reversed: 0, payroll: 0 },
    reconciliation: await getMatrizStage5LedgerReconciliation(environment, dbPool),
  };
  const commissions = await sweepCommissionEntries(environment, dbPool);
  const client = await dbPool.connect();
  let payrollCount = 0;
  try {
    await client.query('BEGIN');
    const payroll = await client.query<{
      source_expense_id: string; payment_status: 'pending' | 'paid';
    }>(
      `SELECT i.source_expense_id,i.payment_status
         FROM finance.matriz_payroll_items i
         JOIN commerce.matriz_expenses e
           ON e.environment=i.environment AND e.id=i.source_expense_id
        WHERE i.environment=$1 AND e.deleted_at IS NULL
          AND e.category='funcionario' AND e.amount=i.total_due
          AND e.payment_status=i.payment_status AND (
            NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=i.environment
                AND t.source_type='commerce.matriz_expense.accrual'
                AND t.source_id=i.source_expense_id::text)
            OR (i.payment_status='paid' AND EXISTS (
              SELECT 1 FROM finance.matriz_ledger_transactions t
               WHERE t.environment=i.environment
                 AND t.source_type='commerce.matriz_expense.accrual'
                 AND t.source_id=i.source_expense_id::text
                 AND t.transaction_kind='expense_payable')
              AND NOT EXISTS (
                SELECT 1 FROM finance.matriz_ledger_transactions t
                 WHERE t.environment=i.environment
                   AND t.source_type='commerce.matriz_expense.payment'
                   AND t.source_id=i.source_expense_id::text))
          ) ORDER BY i.created_at,i.id LIMIT $2
          FOR UPDATE OF i SKIP LOCKED`,
      [environment, limit],
    );
    for (const item of payroll.rows) {
      const expense = await getMatrizExpenseLedgerState(
        client, environment, item.source_expense_id,
      );
      const prior = await client.query<{ transaction_kind: string }>(
        `SELECT transaction_kind FROM finance.matriz_ledger_transactions
          WHERE environment=$1 AND source_type='commerce.matriz_expense.accrual'
            AND source_id=$2`,
        [environment, item.source_expense_id],
      );
      await ensureMatrizExpenseAccrual(client, expense);
      if (item.payment_status === 'paid'
        && prior.rows[0]?.transaction_kind === 'expense_payable') {
        await postMatrizExpensePayment(
          client, expense, expense.paidAt ?? expense.occurredAt,
          'system:stage5-backfill',
        );
      }
      payrollCount += 1;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return {
    enabled: true,
    processed: {
      commissions_created: commissions.created,
      commissions_reversed: commissions.reversed,
      payroll: payrollCount,
    },
    reconciliation: await getMatrizStage5LedgerReconciliation(environment, dbPool),
  };
}
