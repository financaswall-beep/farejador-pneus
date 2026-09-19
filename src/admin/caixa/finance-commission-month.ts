import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { businessDateSaoPaulo } from '../../shared/business-time.js';
import { getMatrizCollaboratorManagement } from '../painel/queries-colaboradores-gestao.js';
import { matrizCommissionFactsSql } from './operation-commission-facts.js';
import { money } from '../../shared/operation-commissions.js';

type Reader = Pick<Pool, 'query'>;
type Settlement = {
  id: string; collaborator_id: string; name: string; role: string; frequency: 'monthly' | 'weekly';
  period_start: string; period_end: string; commission_amount: string; payment_total: string;
  status: 'pending' | 'paid'; paid_at: string | null; due_on: string | null;
};
function bounds(period: string) {
  const start = period + '-01', [year, month] = period.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 10);
  const tomorrow = new Date(businessDateSaoPaulo(new Date()) + 'T12:00:00Z');
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return { start, end: [next, tomorrow.toISOString().slice(0, 10)].sort()[0]!, next };
}
/** Consulta os fechamentos persistidos e as mesmas regras de apuração usadas pela Equipe web. */
export async function getFinanceCommissionMonth(period: string, db: Reader = pool) {
  const b = bounds(period);
  const [management, facts, closed] = await Promise.all([
    getMatrizCollaboratorManagement(b.start, env.FAREJADOR_ENV, db),
    db.query<{ collaborator_id: string; commission_amount: string; gross_sales: string; sales_count: number }>(
      `${matrizCommissionFactsSql} SELECT collaborator_id,sum(commission_amount)::text commission_amount,
       sum(gross_amount)::text gross_sales,count(*)::int sales_count FROM ruled GROUP BY collaborator_id`,
      [env.FAREJADOR_ENV, b.start, b.end]),
    db.query<Settlement>(
      `SELECT i.id,i.collaborator_id,c.display_name name,c.job_title role,'monthly'::text frequency,
              p.competence::text period_start,(p.competence+interval '1 month-1 day')::date::text period_end,
              i.commission_amount::text,i.total_due::text payment_total,i.payment_status status,
              i.paid_at::text,i.due_date::text due_on
         FROM finance.matriz_payroll_items i JOIN finance.matriz_payroll_periods p
           ON p.environment=i.environment AND p.id=i.payroll_period_id
         JOIN network.matriz_collaborators c ON c.environment=i.environment AND c.id=i.collaborator_id
        WHERE i.environment=$1 AND p.competence=$2::date AND i.commission_amount<>0
        UNION ALL
       SELECT w.id,w.collaborator_id,c.display_name,c.job_title,'weekly',w.period_start::text,w.period_end::text,
              w.commission_amount::text,w.commission_amount::text,w.payment_status,e.paid_at::text,e.due_date::text
         FROM finance.matriz_commission_periods w JOIN network.matriz_collaborators c
           ON c.environment=w.environment AND c.id=w.collaborator_id
         JOIN commerce.matriz_expenses e ON e.environment=w.environment AND e.id=w.source_expense_id
        WHERE w.environment=$1 AND w.period_end >= $2::date AND w.period_end < $3::date
        ORDER BY period_start DESC,name`, [env.FAREJADOR_ENV, b.start, b.next]),
  ]);
  const collaborators = management.collaborators.filter(r => r.commission_active || r.commission_amount !== 0
    || closed.rows.some(s => s.collaborator_id === r.id)).map(r => {
    const fact = facts.rows.find(f => f.collaborator_id === r.id);
    return { id: r.id, name: r.display_name, role: r.job_title || r.job, active: r.active,
      commission_amount: r.commission_settlement_frequency === 'weekly' ? money(fact?.commission_amount) : r.commission_amount,
      gross_sales: r.revenue, margin: r.margin, sales_count: r.sales_count,
      commission_kind: r.commission_kind, commission_basis: r.commission_basis, commission_value: r.commission_value,
      commission_itemized: r.commission_itemized, commission_item_rules: r.commission_item_rules,
      frequency: r.commission_settlement_frequency, missing_cost_items: r.items_without_cost };
  });
  return { period, as_of: new Date().toISOString(), collaborators, settlements: closed.rows,
    summary: { accrued: money(collaborators.reduce((s, r) => s + r.commission_amount, 0)),
      paid: money(closed.rows.filter(r => r.status === 'paid').reduce((s, r) => s + Number(r.commission_amount), 0)),
      payable: money(closed.rows.filter(r => r.status === 'pending').reduce((s, r) => s + Number(r.commission_amount), 0)),
      payment_total: money(closed.rows.filter(r => r.status === 'pending').reduce((s, r) => s + Number(r.payment_total), 0)) } };
}

export async function getFinanceCommissionMonthDetail(period: string, collaboratorId: string, targetId?: string, offset = 0, db: Reader = pool) {
  const overview = await getFinanceCommissionMonth(period, db);
  const person = overview.collaborators.find(r => r.id === collaboratorId);
  const settlement = overview.settlements.find(r => r.id === targetId && r.collaborator_id === collaboratorId);
  if ((!person && !settlement) || (targetId && !settlement)) return null;
  const b = bounds(period), start = settlement?.period_start ?? b.start;
  const endDate = settlement ? new Date(settlement.period_end + 'T12:00:00Z') : null;
  if (endDate) endDate.setUTCDate(endDate.getUTCDate() + 1);
  const sales = await db.query<{ id: string; reference: string; occurred_at: string; gross_amount: string;
    commission_amount: string; total: number }>(`${matrizCommissionFactsSql}
    SELECT id,reference,occurred_at,gross_amount::text,commission_amount::text,count(*) OVER()::int total
      FROM ruled WHERE collaborator_id=$4 AND commission_amount<>0 ORDER BY occurred_at DESC,id LIMIT 50 OFFSET $5`,
    [env.FAREJADOR_ENV, start, endDate?.toISOString().slice(0, 10) ?? b.end, collaboratorId, offset]);
  return { period, person, settlement: settlement ?? null, sales: sales.rows, offset, total: sales.rows[0]?.total ?? 0 };
}
