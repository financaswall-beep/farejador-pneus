import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { SimpleFinanceRange } from '../../shared/simple-finance.js';
import {
  money,
  operationCommissionBounds,
  type OperationCommissionCollaborator,
  type OperationCommissionDetailPayload,
  type OperationCommissionSale,
  type OperationCommissionsPayload,
} from '../../shared/operation-commissions.js';
import { commissionItemRulesOf, emptyCommissionItemRules } from '../../shared/operation-team.js';
import {
  getMatrizCollaboratorManagement,
  payMatrizPayrollItem,
} from '../painel/queries.js';
import { getMatrizExpenseLedgerState, postMatrizExpensePayment } from '../painel/matriz-ledger-expenses.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from '../painel/stage5-integrity.js';
import { matrizCommissionFactsSql } from './operation-commission-facts.js';
export { closeMatrizWeeklyCommissions } from './operation-commission-rollover.js';

type Queryable = Pick<Pool, 'query'>;

type SettlementRow = {
  collaborator_id: string; target_id: string; payment_total: string;
  payment_status: 'pending' | 'paid'; period_start: string; period_end: string;
  settlement_frequency: 'weekly' | 'monthly';
};

async function performanceRows(range: SimpleFinanceRange, db: Queryable) {
  const bounds = operationCommissionBounds(range);
  return db.query<{
    collaborator_id: string; sales_count: number; gross_sales: string;
    commission_amount: string;
  }>(
    `${matrizCommissionFactsSql}
     SELECT collaborator_id,count(*) FILTER (WHERE commission_amount>0)::int sales_count,
            COALESCE(sum(gross_amount),0)::text gross_sales,
            COALESCE(sum(commission_amount),0)::text commission_amount
       FROM ruled GROUP BY collaborator_id`,
    [env.FAREJADOR_ENV, bounds.start, bounds.end],
  );
}

export async function getMatrizOperationCommissions(
  range: SimpleFinanceRange,
  db: Queryable = defaultPool,
): Promise<OperationCommissionsPayload> {
  const bounds = operationCommissionBounds(range);
  const [management, performance, settlementResult] = await Promise.all([
    getMatrizCollaboratorManagement(bounds.competence, env.FAREJADOR_ENV, db),
    performanceRows(range, db),
    db.query<SettlementRow>(
      `SELECT item.collaborator_id,item.id target_id,item.total_due::text payment_total,
              item.payment_status,period.competence::text period_start,
              (period.competence+interval '1 month-1 day')::date::text period_end,
              'monthly'::text settlement_frequency
         FROM finance.matriz_payroll_items item
         JOIN finance.matriz_payroll_periods period
           ON period.environment=item.environment AND period.id=item.payroll_period_id
        WHERE item.environment=$1
        UNION ALL
       SELECT weekly.collaborator_id,weekly.id,weekly.commission_amount::text,
              weekly.payment_status,weekly.period_start::text,weekly.period_end::text,
              'weekly'::text
         FROM finance.matriz_commission_periods weekly
        WHERE weekly.environment=$1
        ORDER BY period_start DESC`,
      [env.FAREJADOR_ENV],
    ),
  ]);
  const values = new Map(performance.rows.map((row) => [row.collaborator_id, row]));
  const collaborators: OperationCommissionCollaborator[] = management.collaborators
    .filter((row) => row.commission_active || values.has(row.id) || row.payroll_item_id)
    .map((row): OperationCommissionCollaborator => {
      const value = values.get(row.id);
      const frequency = row.commission_settlement_frequency ?? 'monthly';
      const ownSettlements = settlementResult.rows.filter((item) =>
        item.collaborator_id === row.id);
      const pending = ownSettlements.filter((item) => item.payment_status === 'pending')
        .sort((a, b) => a.period_start.localeCompare(b.period_start))[0];
      const paid = ownSettlements.some((item) => item.payment_status === 'paid');
      return {
        id: row.id,
        name: row.display_name,
        username: row.username,
        role: row.job_title || row.job || 'Colaborador',
        active: row.active,
        sales_count: Number(value?.sales_count ?? 0),
        gross_sales: money(value?.gross_sales),
        commission_kind: row.commission_kind,
        commission_basis: row.commission_basis,
        commission_value: money(row.commission_value),
        commission_amount: money(value?.commission_amount),
        commission_itemized: Boolean(row.commission_itemized),
        commission_item_rules: row.commission_item_rules ?? emptyCommissionItemRules(),
        settlement_frequency: pending?.settlement_frequency ?? frequency,
        status: pending ? 'payable' : (paid && !Number(value?.commission_amount ?? 0) ? 'paid' : 'open'),
        payment_target_id: pending?.target_id ?? null,
        payment_total: pending ? money(pending.payment_total) : null,
        payment_period_start: pending?.period_start ?? null,
        payment_period_end: pending?.period_end ?? null,
      };
    })
    .sort((a, b) => b.commission_amount - a.commission_amount || a.name.localeCompare(b.name));
  const totalCommission = money(collaborators.reduce((sum, row) => sum + row.commission_amount, 0));
  const totalSales = collaborators.reduce((sum, row) => sum + row.sales_count, 0);
  return {
    range,
    unit_name: 'Matriz',
    total_commission: totalCommission,
    total_sales: totalSales,
    average_commission: totalSales ? money(totalCommission / totalSales) : 0,
    collaborators,
  };
}

export async function getMatrizOperationCommissionDetail(
  collaboratorId: string,
  range: SimpleFinanceRange,
  db: Queryable = defaultPool,
): Promise<OperationCommissionDetailPayload | null> {
  const overview = await getMatrizOperationCommissions(range, db);
  const collaborator = overview.collaborators.find((row) => row.id === collaboratorId);
  if (!collaborator) return null;
  const bounds = operationCommissionBounds(range);
  const detailStart = collaborator.status === 'payable' && collaborator.payment_period_start
    ? collaborator.payment_period_start : bounds.start;
  const detailEnd = collaborator.status === 'payable' && collaborator.payment_period_end
    ? new Date(`${collaborator.payment_period_end}T12:00:00Z`).toISOString().slice(0, 10)
    : bounds.end;
  const exclusiveEnd = collaborator.status === 'payable' && collaborator.payment_period_end
    ? new Date(new Date(`${detailEnd}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10)
    : detailEnd;
  const result = await db.query<{
    id: string; reference: string; occurred_at: string; payment_method: string | null;
    gross_amount: string; commission_amount: string; commission_itemized: boolean;
    commission_item_rules: unknown;
  }>(
    `${matrizCommissionFactsSql}
     SELECT id,reference,occurred_at,payment_method,gross_amount::text,
            commission_amount::text,commission_itemized,commission_item_rules
       FROM ruled WHERE collaborator_id=$4 AND commission_amount>0
       ORDER BY occurred_at DESC LIMIT 200`,
    [env.FAREJADOR_ENV, detailStart, exclusiveEnd, collaboratorId],
  );
  const sales: OperationCommissionSale[] = result.rows.map((row) => ({
    entry_type: 'sale',
    id: row.id,
    reference: row.reference,
    occurred_at: row.occurred_at,
    payment_method: row.payment_method,
    gross_amount: money(row.gross_amount),
    commission_amount: money(row.commission_amount),
    commission_itemized: Boolean(row.commission_itemized),
    commission_item_rules: commissionItemRulesOf(row.commission_item_rules),
  }));
  const detailCollaborator = collaborator.status === 'payable' ? {
    ...collaborator,
    sales_count: sales.length,
    gross_sales: money(sales.reduce((sum, sale) => sum + sale.gross_amount, 0)),
    commission_amount: money(sales.reduce((sum, sale) => sum + sale.commission_amount, 0)),
  } : collaborator;
  return { range, unit_name: 'Matriz', collaborator: detailCollaborator, sales };
}

export async function payMatrizOperationCommission(
  collaboratorId: string,
  payrollItemId: string,
  idempotencyKey: string,
  actorLabel: string,
  db: Pool = defaultPool,
) {
  const allowed = await db.query(
    `SELECT 1 FROM finance.matriz_payroll_items item
      WHERE item.environment=$1 AND item.id=$2 AND item.collaborator_id=$3
        AND item.payment_status='pending'`,
    [env.FAREJADOR_ENV, payrollItemId, collaboratorId],
  );
  if (allowed.rowCount === 1) {
    return payMatrizPayrollItem({
      item_id: payrollItemId,
      environment: env.FAREJADOR_ENV,
      actor_label: actorLabel,
      idempotency_key: idempotencyKey,
    }, db);
  }
  const client = await db.connect();
  const operation = {
    environment: env.FAREJADOR_ENV, domain: 'matriz_commission.pay',
    idempotencyKey, fingerprint: operationFingerprint({ period_id: payrollItemId }),
  };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<{
      paid: true; period_id: string; paid_at: string;
    }>(client, operation);
    if (started.replayed) { await client.query('COMMIT'); return started.result; }
    const period = await client.query<{
      source_expense_id: string; commission_amount: string; payment_status: string;
    }>(
      `SELECT source_expense_id,commission_amount::text,payment_status
         FROM finance.matriz_commission_periods
        WHERE environment=$1 AND id=$2 AND collaborator_id=$3 FOR UPDATE`,
      [env.FAREJADOR_ENV, payrollItemId, collaboratorId],
    );
    if (!period.rows[0] || period.rows[0].payment_status !== 'pending') {
      throw new Error('commission_payment_not_available');
    }
    const expense = await getMatrizExpenseLedgerState(
      client, env.FAREJADOR_ENV, period.rows[0].source_expense_id,
    );
    if (expense.paymentStatus !== 'pending') throw new Error('commission_payment_not_available');
    const paidAt = new Date().toISOString();
    await client.query(`SELECT set_config('app.actor_label',$1,true)`, [actorLabel]);
    await client.query(
      `UPDATE commerce.matriz_expenses SET payment_status='paid',paid_at=$3::timestamptz
        WHERE environment=$1 AND id=$2 AND payment_status='pending' AND deleted_at IS NULL`,
      [env.FAREJADOR_ENV, period.rows[0].source_expense_id, paidAt],
    );
    await postMatrizExpensePayment(client, expense, paidAt, actorLabel);
    const result = integrityResult({ paid: true as const, period_id: payrollItemId, paid_at: paidAt });
    await recordIntegrityEvent(client, {
      environment: env.FAREJADOR_ENV, domain: 'matriz_commission',
      entityTable: 'finance.matriz_commission_periods', entityId: payrollItemId,
      eventType: 'weekly_commission_paid', actorLabel, idempotencyKey,
      before: { payment_status: 'pending', amount: period.rows[0].commission_amount },
      after: { payment_status: 'paid', paid_at: paidAt },
    });
    await completeIntegrityOperation(
      client, operation, 'finance.matriz_commission_periods', payrollItemId, result,
    );
    await client.query('COMMIT'); return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); throw error;
  } finally { client.release(); }
}
