import type { Pool } from 'pg';
import { pendingCommissionFacts } from './commission-batch.js';

export async function pendingMonthlyCommissionDetails(
  db: Pick<Pool, 'query'>, environment: 'prod' | 'test', collaboratorId: string,
  end: string, competence: string, limit = 200, offset = 0,
) {
  const facts = (await pendingCommissionFacts(db, environment, end, 'monthly', competence))
    .filter(row => row.collaborator_id === collaboratorId)
    .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime() || a.id.localeCompare(b.id));
  return { rows: facts.slice(offset, offset + limit).map(row => ({ ...row, total: facts.length })) };
}

export async function frozenCommissionDetails(
  db: Pick<Pool, 'query'>, environment: string, collaboratorId: string,
  targetId: string | undefined, limit = 200, offset = 0,
) {
  if (!targetId) return null;
  const legacy = await db.query(`SELECT 1 FROM finance.matriz_commission_legacy_periods
    WHERE environment=$1 AND target_id=$2 AND collaborator_id=$3`, [environment, targetId, collaboratorId]);
  if (legacy.rowCount) return null;
  return db.query<{
    id: string; reference: string; occurred_at: string; payment_method: string | null;
    gross_amount: string; commission_amount: string; commission_itemized: boolean;
    commission_item_rules: unknown; total: number;
  }>(
    `SELECT f.source_id::text id,f.calculation->>'reference' reference,f.occurred_at,
            f.calculation->>'payment_method' payment_method,
            f.calculation->>'gross_amount' gross_amount,f.amount::text commission_amount,
            COALESCE((f.calculation->>'commission_itemized')::boolean,false) commission_itemized,
            f.calculation->'commission_item_rules' commission_item_rules,count(*) OVER()::int total
       FROM finance.matriz_commission_facts f
      WHERE f.environment=$1 AND f.collaborator_id=$2
        AND (f.payroll_item_id=$3 OR f.commission_period_id=$3)
      ORDER BY f.occurred_at DESC,f.id LIMIT $4 OFFSET $5`,
    [environment, collaboratorId, targetId, limit, offset],
  );
}
