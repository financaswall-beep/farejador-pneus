import type { Pool } from 'pg';
import { matrizCommissionFactsSql } from './operation-commission-facts.js';

type Queryable = Pick<Pool, 'query'>;
export interface CommissionFact {
  collaborator_id: string; source_id: string; source_type: string;
  occurred_at: string; reference: string; gross_amount: string;
  commission_amount: string; items_without_cost: number; commission_basis: string;
  settlement_frequency: 'monthly' | 'weekly'; fact_key: string;
  id: string; payment_method: string | null; commission_itemized: boolean;
  commission_item_rules: unknown;
  [key: string]: unknown;
}

const pendingSql = `${matrizCommissionFactsSql}, eligible AS (
  SELECT r.*,COALESCE(r.sale_channel,r.event_type) source_type,
         COALESCE(r.sale_channel,r.event_type)||':'||r.source_id::text||':'||r.collaborator_id::text fact_key
    FROM ruled r
   WHERE r.settlement_frequency=$4
     AND (r.commission_amount>0 OR (r.commission_basis='margin' AND r.items_without_cost>0))
     AND NOT EXISTS (SELECT 1 FROM finance.matriz_commission_facts f
       WHERE f.environment=$1 AND f.source_type=COALESCE(r.sale_channel,r.event_type)
         AND f.source_id=r.source_id AND f.collaborator_id=r.collaborator_id)
     AND NOT EXISTS (SELECT 1 FROM finance.matriz_commission_legacy_periods p
       WHERE p.environment=$1 AND p.collaborator_id=r.collaborator_id
         AND p.frequency=r.settlement_frequency
         AND (r.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN p.period_start AND p.period_end
         AND r.registered_at<=p.closed_at)
) SELECT * FROM eligible`;

export async function pendingCommissionFacts(
  db: Queryable, environment: 'prod' | 'test', end: string,
  frequency: 'monthly' | 'weekly', competence?: string,
): Promise<CommissionFact[]> {
  const filter = competence ? ` WHERE (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date >= $5::date
    OR EXISTS (SELECT 1 FROM finance.matriz_payroll_periods p WHERE p.environment=$1
      AND p.competence=date_trunc('month',occurred_at AT TIME ZONE 'America/Sao_Paulo')::date)` : '';
  const params = [environment, '1900-01-01', end, frequency];
  if (competence) params.push(competence);
  return (await db.query<CommissionFact>(pendingSql + filter, params)).rows;
}

/** Lock the business facts before the payroll lock, matching cancellation's order. */
export async function lockCommissionSources(db: Queryable, environment: string, facts: CommissionFact[]) {
  const tables = [
    ['commerce.matriz_delivery_trips', ['trip']],
    ['commerce.orders', ['retail', 'delivery']],
    ['commerce.wholesale_orders', ['wholesale']],
  ] as const;
  for (const [table, types] of tables) {
    const ids = [...new Set(facts.filter((f) => (types as readonly string[]).includes(f.source_type))
      .map((f) => f.source_id))].sort();
    if (ids.length) await db.query(`SELECT id FROM ${table}
      WHERE environment=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [environment, ids]);
  }
}

export async function freezeCommissionFacts(
  db: Queryable, environment: string, facts: CommissionFact[],
  target: { payrollItemId?: string; weeklyPeriodId?: string },
) {
  for (const fact of facts) await db.query(
    `INSERT INTO finance.matriz_commission_facts
      (environment,collaborator_id,source_type,source_id,occurred_at,amount,
       payroll_item_id,commission_period_id,calculation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [environment, fact.collaborator_id, fact.source_type, fact.source_id, fact.occurred_at,
      fact.commission_amount, target.payrollItemId ?? null, target.weeklyPeriodId ?? null,
      JSON.stringify(fact)],
  );
}

export function commissionTotals(facts: CommissionFact[]) {
  const result = new Map<string, { amount: number; missingCosts: number }>();
  for (const fact of facts) {
    const value = result.get(fact.collaborator_id) ?? { amount: 0, missingCosts: 0 };
    value.amount += Math.round(Number(fact.commission_amount) * 100);
    if (fact.commission_basis === 'margin') value.missingCosts += fact.items_without_cost;
    result.set(fact.collaborator_id, value);
  }
  return result;
}
