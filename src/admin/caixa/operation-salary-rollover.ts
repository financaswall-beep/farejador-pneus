import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import {
  ensureMatrizExpenseAccrual,
  getMatrizExpenseLedgerState,
} from '../painel/matriz-ledger-expenses.js';

function localDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export async function closeMatrizWeeklySalaries(
  db: PoolClient,
  now = new Date(),
): Promise<{ periods_created: number }> {
  const today = localDate(now);
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `matriz-weekly-salary:${env.FAREJADOR_ENV}`,
  ]);
  const candidates = await db.query<{
    collaborator_id: string; display_name: string; period_start: string;
    period_end: string; salary_amount: string;
  }>(
    `SELECT mc.id collaborator_id,mc.display_name,week_start::date::text period_start,
            (week_start::date+6)::text period_end,cfg.base_salary::text salary_amount
       FROM network.matriz_collaborators mc
       CROSS JOIN LATERAL generate_series(
         (SELECT min(c.starts_on)-extract(dow FROM min(c.starts_on))::int
            FROM network.matriz_collaborator_compensation c
           WHERE c.environment=mc.environment AND c.collaborator_id=mc.id),
         $2::date,interval '1 week') week_start
       JOIN LATERAL (
         SELECT c.base_salary,c.salary_frequency
           FROM network.matriz_collaborator_compensation c
          WHERE c.environment=mc.environment AND c.collaborator_id=mc.id
            AND c.starts_on<=week_start::date
          ORDER BY c.starts_on DESC LIMIT 1
       ) cfg ON true
      WHERE mc.environment=$1 AND cfg.salary_frequency='weekly' AND cfg.base_salary>0
        AND week_start::date+6<$2::date
        AND mc.created_at<(week_start::date+7)
        AND (mc.revoked_at IS NULL OR mc.revoked_at>=week_start::date)
        AND NOT EXISTS (SELECT 1 FROM finance.matriz_salary_periods p
          WHERE p.environment=mc.environment AND p.collaborator_id=mc.id
            AND p.period_start=week_start::date)
      ORDER BY week_start,mc.id`,
    [env.FAREJADOR_ENV, today],
  );
  let created = 0;
  for (const row of candidates.rows) {
    const expense = await db.query<{ id: string }>(
      `INSERT INTO commerce.matriz_expenses
        (environment,category,description,amount,occurred_at,payment_status,
         due_date,created_by,competence_month,document_date)
       VALUES ($1,'funcionario',$2,$3,$4::date,'pending',($4::date+1),$5,
         date_trunc('month',$4::date)::date,$4::date) RETURNING id`,
      [env.FAREJADOR_ENV,
       `Salário semanal · ${row.display_name} · ${row.period_start} a ${row.period_end}`,
       row.salary_amount, row.period_end, 'system:weekly-salary-rollover'],
    );
    await db.query(
      `INSERT INTO finance.matriz_salary_periods
        (environment,collaborator_id,period_start,period_end,salary_amount,
         source_expense_id,closed_at)
       VALUES ($1,$2,$3::date,$4::date,$5,$6,$7::timestamptz)`,
      [env.FAREJADOR_ENV, row.collaborator_id, row.period_start, row.period_end,
       row.salary_amount, expense.rows[0]!.id, now.toISOString()],
    );
    await ensureMatrizExpenseAccrual(
      db, await getMatrizExpenseLedgerState(db, env.FAREJADOR_ENV, expense.rows[0]!.id),
    );
    created += 1;
  }
  return { periods_created: created };
}
