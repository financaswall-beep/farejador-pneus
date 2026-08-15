import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import {
  ensureMatrizExpenseAccrual,
  getMatrizExpenseLedgerState,
} from '../painel/matriz-ledger-expenses.js';
import { matrizCommissionFactsSql } from './operation-commission-facts.js';

function localDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export async function closeMatrizWeeklyCommissions(
  db: PoolClient,
  now = new Date(),
): Promise<{ periods_created: number }> {
  const today = localDate(now);
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `matriz-weekly-commission:${env.FAREJADOR_ENV}`,
  ]);
  const earliest = await db.query<{ starts_on: string | null }>(
    `SELECT min(starts_on)::text starts_on
       FROM network.matriz_collaborator_commission_rules
      WHERE environment=$1 AND active AND settlement_frequency='weekly'`,
    [env.FAREJADOR_ENV],
  );
  if (!earliest.rows[0]?.starts_on) return { periods_created: 0 };
  const facts = await db.query<{
    collaborator_id: string; period_start: string; period_end: string;
    sales_count: number; gross_sales: string; commission_amount: string;
  }>(
    `${matrizCommissionFactsSql}
     SELECT collaborator_id,
            (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
              - extract(dow FROM occurred_at AT TIME ZONE 'America/Sao_Paulo')::int period_start,
            (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
              - extract(dow FROM occurred_at AT TIME ZONE 'America/Sao_Paulo')::int + 6 period_end,
            count(*)::int sales_count,COALESCE(sum(gross_amount),0)::text gross_sales,
            COALESCE(sum(commission_amount),0)::text commission_amount
       FROM ruled
      WHERE settlement_frequency='weekly' AND commission_amount>0
        AND ((occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
          - extract(dow FROM occurred_at AT TIME ZONE 'America/Sao_Paulo')::int + 6)<$4::date
      GROUP BY collaborator_id,period_start,period_end
      HAVING count(*) FILTER (WHERE commission_basis='margin' AND items_without_cost>0)=0
      ORDER BY period_start,collaborator_id`,
    [env.FAREJADOR_ENV, earliest.rows[0].starts_on, today, today],
  );
  let created = 0;
  for (const row of facts.rows) {
    const exists = await db.query(
      `SELECT 1 FROM finance.matriz_commission_periods
        WHERE environment=$1 AND collaborator_id=$2
          AND settlement_frequency='weekly' AND period_start=$3::date`,
      [env.FAREJADOR_ENV, row.collaborator_id, row.period_start],
    );
    if (exists.rowCount) continue;
    const person = await db.query<{ display_name: string }>(
      `SELECT display_name FROM network.matriz_collaborators
        WHERE environment=$1 AND id=$2`,
      [env.FAREJADOR_ENV, row.collaborator_id],
    );
    const label = person.rows[0]?.display_name ?? 'Colaborador';
    const expense = await db.query<{ id: string }>(
      `INSERT INTO commerce.matriz_expenses
        (environment,category,description,amount,occurred_at,payment_status,
         due_date,created_by,competence_month,document_date)
       VALUES ($1,'funcionario',$2,$3,$4::date,'pending',($4::date+1),$5,
         date_trunc('month',$4::date)::date,$4::date) RETURNING id`,
      [env.FAREJADOR_ENV,
       `Comissão semanal · ${label} · ${row.period_start} a ${row.period_end}`,
       row.commission_amount, row.period_end, 'system:weekly-rollover'],
    );
    await db.query(
      `INSERT INTO finance.matriz_commission_periods
        (environment,collaborator_id,settlement_frequency,period_start,period_end,
         sales_count,gross_sales,commission_amount,source_expense_id,closed_at)
       VALUES ($1,$2,'weekly',$3::date,$4::date,$5,$6,$7,$8,$9::timestamptz)`,
      [env.FAREJADOR_ENV, row.collaborator_id, row.period_start, row.period_end,
       row.sales_count, row.gross_sales, row.commission_amount, expense.rows[0]!.id,
       now.toISOString()],
    );
    await ensureMatrizExpenseAccrual(
      db, await getMatrizExpenseLedgerState(db, env.FAREJADOR_ENV, expense.rows[0]!.id),
    );
    created += 1;
  }
  return { periods_created: created };
}
