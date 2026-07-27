import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  runMatrizStage3LedgerBackfill,
} from './matriz-ledger-stage3-reconciliation.js';
import {
  getMatrizStage3LedgerReconciliation,
} from './matriz-ledger-stage3-report.js';
import {
  getMatrizStage4LedgerReconciliation, runMatrizStage4LedgerBackfill,
} from './matriz-ledger-stage4-reconciliation.js';
import {
  getMatrizStage5LedgerReconciliation, runMatrizStage5LedgerBackfill,
} from './matriz-ledger-stage5-reconciliation.js';

type Environment = 'prod' | 'test';
type HealthStatus = 'green' | 'yellow' | 'red';

interface ModuleHealth {
  status: HealthStatus;
  score: number;
  errors: number;
  pending: number;
}

function moduleHealth(errors: number, pending = 0): ModuleHealth {
  return {
    status: errors > 0 ? 'red' : pending > 0 ? 'yellow' : 'green',
    score: errors > 0 ? Math.max(0, 10 - Math.min(10, errors * 2))
      : pending > 0 ? 7 : 10,
    errors,
    pending,
  };
}

function sumKeys(values: Record<string, number>, prefixes: string[]): number {
  return Object.entries(values).reduce(
    (sum, [key, value]) => sum
      + (prefixes.some((prefix) => key.startsWith(prefix)) ? Number(value) : 0),
    0,
  );
}

export interface MatrizLedgerIntegrationHealth {
  enabled: boolean;
  status: 'disabled' | HealthStatus;
  modules: Record<
    'financeiro' | 'compras' | 'atacado' | 'varejo' | 'estoque'
    | 'logistica' | 'marketing' | 'rede' | 'colaboradores',
    ModuleHealth
  >;
  global: {
    duplicate_sources: number;
    orphan_sources: number;
    unbalanced_transactions: number;
    cash_date_missing: number;
    total_error_signals: number;
  };
  checked_at: string;
}

export async function getMatrizLedgerIntegrationHealth(
  environment: Environment = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizLedgerIntegrationHealth> {
  const [stage3, stage4, stage5, globalResult] = await Promise.all([
    getMatrizStage3LedgerReconciliation(environment, dbPool),
    getMatrizStage4LedgerReconciliation(environment, dbPool),
    getMatrizStage5LedgerReconciliation(environment, dbPool),
    dbPool.query<{
      duplicate_sources: number; orphan_sources: number;
      unbalanced_transactions: number; cash_date_missing: number;
      checked_at: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM (
           SELECT source_type,source_id FROM finance.matriz_ledger_transactions
            WHERE environment=$1 GROUP BY source_type,source_id HAVING count(*)>1
         ) duplicates) duplicate_sources,
         (SELECT count(*)::int FROM finance.matriz_ledger_transactions t
           WHERE t.environment=$1 AND (
             (t.source_type LIKE 'commerce.wholesale_purchase.%' AND NOT EXISTS (
               SELECT 1 FROM commerce.wholesale_purchases x
                WHERE x.environment=t.environment AND x.id::text=t.source_id))
             OR (t.source_type LIKE 'commerce.wholesale_order.%' AND NOT EXISTS (
               SELECT 1 FROM commerce.wholesale_orders x
                WHERE x.environment=t.environment AND x.id::text=t.source_id))
             OR (t.source_type LIKE 'commerce.order.%' AND NOT EXISTS (
               SELECT 1 FROM commerce.orders x
                WHERE x.environment=t.environment AND x.id::text=t.source_id))
             OR (t.source_type='finance.inventory_adjustment' AND NOT EXISTS (
               SELECT 1 FROM finance.matriz_inventory_adjustments x
                WHERE x.environment=t.environment AND x.id::text=t.source_id))
             OR (t.source_type LIKE 'commerce.matriz_expense.%' AND NOT EXISTS (
               SELECT 1 FROM commerce.matriz_expenses x
                WHERE x.environment=t.environment AND x.id::text=t.source_id))
             OR (t.source_type='marketing.meta_spend.adjustment' AND NOT EXISTS (
               SELECT 1 FROM marketing.meta_insights_daily x
                WHERE x.environment=t.environment
                  AND x.id::text=t.metadata->>'insight_id'))
             OR (t.source_type LIKE 'network.commission_entry.%'
               AND t.source_type<>'network.commission_entry.reversal'
               AND NOT EXISTS (SELECT 1 FROM network.commission_entries x
                 WHERE x.environment=t.environment::text AND x.id::text=t.source_id))
             OR (t.source_type IN (
                   'network.commission_entry.reversal',
                   'network.commission_refund.payment')
               AND NOT EXISTS (SELECT 1 FROM finance.matriz_commission_reversals x
                 WHERE x.environment=t.environment AND x.id::text=t.source_id))
             OR (t.source_type LIKE 'network.monthly_fee.%' AND NOT EXISTS (
               SELECT 1 FROM finance.matriz_partner_monthly_fees x
                WHERE x.environment=t.environment AND x.id::text=t.source_id))
           )) orphan_sources,
         (SELECT count(*)::int FROM (
           SELECT t.id,t.amount,
                  COALESCE(sum(e.amount) FILTER (WHERE e.side='debit'),0) debits,
                  COALESCE(sum(e.amount) FILTER (WHERE e.side='credit'),0) credits
             FROM finance.matriz_ledger_transactions t
             LEFT JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
            WHERE t.environment=$1 GROUP BY t.id,t.amount
           HAVING COALESCE(sum(e.amount) FILTER (WHERE e.side='debit'),0)<>t.amount
               OR COALESCE(sum(e.amount) FILTER (WHERE e.side='credit'),0)<>t.amount
         ) unbalanced) unbalanced_transactions,
         (SELECT count(DISTINCT t.id)::int
            FROM finance.matriz_ledger_transactions t
            JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
           WHERE t.environment=$1 AND e.account_code='cash' AND t.cash_on IS NULL)
           cash_date_missing,
         now()::text checked_at`,
      [environment],
    ),
  ]);
  const globalRow = globalResult.rows[0]!;
  const shared = stage3.amount_mismatches + stage3.orphan_ledger
    + stage3.duplicate_sources;
  const purchaseErrors = sumKeys(stage3.missing, ['purchase_']);
  const wholesaleErrors = sumKeys(stage3.missing, ['wholesale_']);
  const retailErrors = sumKeys(stage3.missing, ['retail_']);
  const stockErrors = Number(stage3.missing.inventory_adjustment_missing ?? 0)
    + sumKeys(stage3.missing, [
      'purchase_stock_', 'wholesale_stock_', 'retail_stock_',
    ]);
  const expenseErrors = stage4.errors.expense_accrual_missing
    + stage4.errors.expense_payment_missing + stage4.errors.expense_remove_missing;
  const logisticsErrors = stage4.errors.receipt_expense_missing;
  const marketingErrors = stage4.errors.marketing_spend_mismatch
    + stage4.errors.marketing_currency_unsupported;
  const networkErrors = stage5.errors.commission_accrual_missing
    + stage5.errors.commission_payment_missing
    + stage5.errors.commission_reversal_missing
    + stage5.errors.commission_refund_payment_missing
    + stage5.errors.monthly_fee_current_missing
    + stage5.errors.monthly_fee_accrual_missing
    + stage5.errors.monthly_fee_payment_missing;
  const payrollErrors = stage5.errors.payroll_accrual_missing
    + stage5.errors.payroll_payment_missing + stage5.errors.payroll_source_mismatch;
  const globalErrors = globalRow.duplicate_sources + globalRow.orphan_sources
    + globalRow.unbalanced_transactions + globalRow.cash_date_missing;
  const totalSignals = stage3.total_problems + stage4.total_errors
    + stage5.total_errors + globalErrors;
  const pending = stage4.pending_operational.fuel_notes_without_approved_receipt
    + stage5.pending_operational.payroll_assignment_gaps_current_month;
  return {
    enabled: env.MATRIZ_CENTRAL_LEDGER,
    status: !env.MATRIZ_CENTRAL_LEDGER ? 'disabled'
      : totalSignals > 0 ? 'red' : pending > 0 ? 'yellow' : 'green',
    modules: {
      financeiro: moduleHealth(expenseErrors + shared + globalErrors),
      compras: moduleHealth(purchaseErrors),
      atacado: moduleHealth(wholesaleErrors),
      varejo: moduleHealth(retailErrors),
      estoque: moduleHealth(stockErrors),
      logistica: moduleHealth(
        logisticsErrors,
        stage4.pending_operational.fuel_notes_without_approved_receipt,
      ),
      marketing: moduleHealth(marketingErrors),
      rede: moduleHealth(networkErrors),
      colaboradores: moduleHealth(
        payrollErrors,
        stage5.pending_operational.payroll_assignment_gaps_current_month,
      ),
    },
    global: {
      duplicate_sources: globalRow.duplicate_sources,
      orphan_sources: globalRow.orphan_sources,
      unbalanced_transactions: globalRow.unbalanced_transactions,
      cash_date_missing: globalRow.cash_date_missing,
      total_error_signals: totalSignals,
    },
    checked_at: globalRow.checked_at,
  };
}

export async function runMatrizLedgerIntegrationBackfill(
  options: { environment?: Environment; limit?: number } = {},
  dbPool: Pool = defaultPool,
) {
  const environment = options.environment ?? env.FAREJADOR_ENV;
  const stage3 = await runMatrizStage3LedgerBackfill(
    { environment, limit: options.limit }, dbPool,
  );
  const stage4 = await runMatrizStage4LedgerBackfill(
    { environment, limit: options.limit }, dbPool,
  );
  const stage5 = await runMatrizStage5LedgerBackfill(
    { environment, limit: options.limit }, dbPool,
  );
  return {
    enabled: env.MATRIZ_CENTRAL_LEDGER,
    processed: {
      stage3: stage3.processed, stage4: stage4.processed, stage5: stage5.processed,
    },
    health: await getMatrizLedgerIntegrationHealth(environment, dbPool),
  };
}
