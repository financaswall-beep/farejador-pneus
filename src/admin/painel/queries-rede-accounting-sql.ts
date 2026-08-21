import { PAINEL_TZ, type PainelRedePeriod } from './queries-pedidos.js';

export function buildRedeAccountingJoins(period: PainelRedePeriod, periodStartSql: string): string {
  const competence = `date_trunc('month', ${periodStartSql} AT TIME ZONE '${PAINEL_TZ}')::date`;
  const inPeriod = (dateColumn: string, competenceColumn: string): string => period === 'month'
    ? `${competenceColumn} = ${competence}`
    : `${dateColumn} >= ${periodStartSql}::timestamptz`;

  return `LEFT JOIN LATERAL (
       -- Regime de competencia: fatos independentes; espelhos de compras/contas ficam fora.
       SELECT
         COALESCE(sum(amount) FILTER (WHERE bucket='employee'),0) AS employee_total,
         COALESCE(sum(amount) FILTER (WHERE bucket='other'),0) AS other_total
       FROM (
         SELECT pe.amount,CASE WHEN pe.category='employee_payment' THEN 'employee' ELSE 'other' END AS bucket
           FROM finance.partner_expenses pe
          WHERE pe.environment=s.environment AND pe.unit_id=s.unit_id
            AND pe.deleted_at IS NULL AND pe.source_payable_id IS NULL
            AND ${inPeriod(`pe.expense_date::timestamp AT TIME ZONE '${PAINEL_TZ}'`, 'pe.competence_month')}
         UNION ALL
         SELECT pp.amount,CASE WHEN pp.category='employee' THEN 'employee' ELSE 'other' END AS bucket
           FROM finance.partner_payables pp
          WHERE pp.environment=s.environment AND pp.unit_id=s.unit_id
            AND pp.deleted_at IS NULL AND pp.source_purchase_id IS NULL
            AND pp.status IN ('open','paid')
            AND ${inPeriod('pp.created_at', 'pp.competence_month')}
         UNION ALL
         SELECT ce.commission_amount,'employee'
           FROM finance.partner_staff_commission_entries ce
          WHERE ce.environment=s.environment AND ce.unit_id=s.unit_id
            AND ce.status='earned' AND ce.settlement_period_id IS NULL
            AND ${inPeriod('ce.realized_at', 'ce.competence_month')}
         UNION ALL
         SELECT ca.amount,'employee'
           FROM finance.partner_staff_commission_adjustments ca
          WHERE ca.environment=s.environment AND ca.unit_id=s.unit_id
            AND ca.settlement_period_id IS NULL
            AND ${inPeriod('ca.occurred_at', 'ca.competence_month')}
       ) recognized_expenses
     ) accounting_expenses ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(f.amount),0) AS open_total,count(*)::int AS open_count
         FROM finance.matriz_partner_monthly_fees f
        WHERE f.environment=s.environment AND f.partner_id=s.partner_id AND f.status='open'
     ) monthly_fees ON true`;
}
