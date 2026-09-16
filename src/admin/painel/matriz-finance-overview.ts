import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

/** Séries completas do livro central, sem o limite de linhas do extrato. */
export async function getMatrizFinanceOverview(
  month: string, environment = env.FAREJADOR_ENV, dbPool: Pool = defaultPool,
) {
  const result = await dbPool.query<{
    period: string; through: string; opening: string;
    days: Array<{ date: string; incoming: string; outgoing: string }>;
    expenses: Array<{ account: string; label: string; amount: string }>;
  }>(
    `WITH bounds AS (
       SELECT to_date($2,'YYYY-MM') starts,
         LEAST((to_date($2,'YYYY-MM')+interval '1 month - 1 day')::date,
           (now() AT TIME ZONE 'America/Sao_Paulo')::date) ends
     ), ledger AS (
       SELECT t.cash_on,t.competence_on,e.account_code,e.account_class,e.side,e.amount
       FROM finance.matriz_ledger_transactions t
       JOIN finance.matriz_ledger_entries e
         ON e.environment=t.environment AND e.transaction_id=t.id
       WHERE t.environment=$1
     ), daily AS (
       SELECT cash_on,
         sum(amount) FILTER (WHERE side='debit') incoming,
         sum(amount) FILTER (WHERE side='credit') outgoing
       FROM ledger,bounds WHERE account_code='cash' AND cash_on BETWEEN starts AND ends
       GROUP BY cash_on
     ), expenses AS (
       SELECT account_code,
         sum(CASE side WHEN 'debit' THEN amount ELSE -amount END) amount
       FROM ledger,bounds WHERE account_class='expense'
         AND account_code NOT IN ('cost_of_goods_sold','inventory_loss','inventory_internal_use')
         AND competence_on>=starts AND competence_on<starts+interval '1 month'
       GROUP BY account_code
     )
     SELECT $2::text period,ends::text through,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM ledger WHERE account_code='cash' AND cash_on<starts),0)::text opening,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('date',d.day::date::text,
         'incoming',COALESCE(c.incoming,0)::text,'outgoing',COALESCE(c.outgoing,0)::text)
         ORDER BY d.day)
         FROM generate_series(starts,ends,interval '1 day') d(day)
         LEFT JOIN daily c ON c.cash_on=d.day::date),'[]') days,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('account',e.account_code,
         'label',COALESCE(cat.label,CASE e.account_code
           WHEN 'marketing_expense' THEN 'Marketing'
           WHEN 'credit_loss' THEN 'Perdas de crédito' ELSE 'Outras despesas' END),
         'amount',e.amount::text) ORDER BY abs(e.amount) DESC,e.account_code)
         FROM expenses e LEFT JOIN commerce.matriz_expense_categories cat
           ON cat.environment=$1 AND 'expense_'||cat.slug=e.account_code
         WHERE e.amount<>0),'[]') expenses
     FROM bounds`, [environment, month],
  );
  return result.rows[0]!;
}
