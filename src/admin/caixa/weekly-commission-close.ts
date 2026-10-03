import type { PoolClient } from 'pg';
import { ensureMatrizExpenseAccrual, getMatrizExpenseLedgerState } from '../painel/matriz-ledger-expenses.js';
import { freezeCommissionFacts, type CommissionFact } from './commission-batch.js';

export async function closeWeeklyCommissionBucket(
  db: PoolClient, environment: 'prod' | 'test', collaboratorId: string,
  start: string, end: string, facts: CommissionFact[], now: Date,
) {
  const earnedCents = facts.reduce((sum, f) => sum + Math.round(Number(f.commission_amount) * 100), 0);
  if (!earnedCents) return;
  await db.query(`SELECT id FROM finance.matriz_payroll_adjustments
    WHERE environment=$1 AND collaborator_id=$2 AND original_commission_period_id IS NOT NULL
      AND deleted_at IS NULL AND causal_status='ready' AND kind='deduction'
      AND created_at <= $3 ORDER BY id FOR UPDATE`, [environment, collaboratorId, now]);
  const adjustments = await db.query<{ id: string; remaining: string }>(
    `SELECT a.id,(a.amount-COALESCE(sum(al.amount),0))::text remaining
       FROM finance.matriz_payroll_adjustments a
       LEFT JOIN finance.matriz_payroll_adjustment_allocations al ON al.environment=a.environment AND al.adjustment_id=a.id
      WHERE a.environment=$1 AND a.collaborator_id=$2 AND a.original_commission_period_id IS NOT NULL
        AND a.deleted_at IS NULL AND a.causal_status='ready' AND a.kind='deduction' AND a.created_at<=$3
      GROUP BY a.id HAVING a.amount>COALESCE(sum(al.amount),0) ORDER BY a.created_at,a.id`,
    [environment, collaboratorId, now],
  );
  let left = earnedCents;
  const allocations = adjustments.rows.map(a => {
    const cents = Math.min(left, Math.round(Number(a.remaining) * 100));
    left -= cents;
    return { id: a.id, amount: cents / 100 };
  }).filter(a => a.amount > 0);
  const person = await db.query<{ display_name: string }>(
    `SELECT display_name FROM network.matriz_collaborators WHERE environment=$1 AND id=$2`,
    [environment, collaboratorId],
  );
  const expense = left > 0 ? await db.query<{ id: string }>(
    `INSERT INTO commerce.matriz_expenses
      (environment,category,description,amount,occurred_at,payment_status,due_date,created_by,competence_month,document_date)
     VALUES ($1,'funcionario',$2,$3,$4::date,'pending',($4::date+1),'system:weekly-rollover',
       date_trunc('month',$4::date)::date,$4::date) RETURNING id`,
    [environment, `Comissão semanal · ${person.rows[0]?.display_name ?? 'Colaborador'} · ${start} a ${end}`, left / 100, end],
  ) : null;
  const period = await db.query<{ id: string }>(
    `INSERT INTO finance.matriz_commission_periods
      (environment,collaborator_id,settlement_frequency,period_start,period_end,sales_count,gross_sales,
       commission_amount,earned_amount,deductions,source_expense_id,closed_at,payment_status,paid_at,paid_by)
     VALUES ($1,$2,'weekly',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
       CASE WHEN $12='paid' THEN $11::timestamptz ELSE NULL END,
       CASE WHEN $12='paid' THEN 'system:zero-balance' ELSE NULL END) RETURNING id`,
    [environment, collaboratorId, start, end, facts.length,
      facts.reduce((sum, f) => sum + Math.round(Number(f.gross_amount) * 100), 0) / 100,
      left / 100, earnedCents / 100, (earnedCents - left) / 100,
      expense?.rows[0]!.id ?? null, now.toISOString(), left > 0 ? 'pending' : 'paid'],
  );
  const periodId = period.rows[0]!.id;
  await freezeCommissionFacts(db, environment, facts, { weeklyPeriodId: periodId });
  for (const allocation of allocations) await db.query(
    `INSERT INTO finance.matriz_payroll_adjustment_allocations(environment,adjustment_id,commission_period_id,amount)
     VALUES ($1,$2,$3,$4)`, [environment, allocation.id, periodId, allocation.amount],
  );
  if (expense) await ensureMatrizExpenseAccrual(db,
    await getMatrizExpenseLedgerState(db, environment, expense.rows[0]!.id));
}
