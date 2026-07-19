import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { recordIntegrityEvent } from './stage5-integrity.js';

export async function reviewMatrizPayrollCausalAdjustment(input: {
  id: string; amount: number; actor_label: string; environment?: 'prod' | 'test';
}, dbPool: Pool = defaultPool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const actorLabel = input.actor_label.trim();
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('invalid_adjustment_amount');
  if (!actorLabel) throw new Error('actor_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const adjustment = await client.query<{
      id: string; competence: string; causal_status: 'ready' | 'needs_review';
      amount: string | null; source_type: string; source_id: string;
    }>(
      `SELECT id,competence::text,causal_status,amount::text,source_type,source_id
         FROM finance.matriz_payroll_adjustments
        WHERE id=$2 AND environment=$1 AND source_type IS NOT NULL AND deleted_at IS NULL
        FOR UPDATE`,
      [environment, input.id],
    );
    const row = adjustment.rows[0];
    if (!row) throw new Error('causal_adjustment_not_found');
    if (row.causal_status === 'ready') {
      if (Number(row.amount) !== input.amount) throw new Error('causal_adjustment_already_reviewed');
      await client.query('COMMIT');
      return { reviewed: true, id: row.id, amount: Number(row.amount) };
    }
    const closed = await client.query(
      `SELECT 1 FROM finance.matriz_payroll_periods
        WHERE environment=$1 AND competence=$2::date`, [environment, row.competence],
    );
    if (closed.rows[0]) throw new Error('period_already_closed');
    await client.query(
      `UPDATE finance.matriz_payroll_adjustments
          SET amount=$3,causal_status='ready',reviewed_by=$4,reviewed_at=now()
        WHERE id=$2 AND environment=$1`,
      [environment, row.id, input.amount, actorLabel],
    );
    await recordIntegrityEvent(client, { environment, domain: 'matriz_payroll',
      entityTable: 'finance.matriz_payroll_adjustments', entityId: row.id,
      eventType: 'causal_adjustment_reviewed', actorLabel,
      idempotencyKey: `payroll-causal-review:${row.id}:${input.amount.toFixed(2)}`,
      before: { causal_status: 'needs_review', amount: null,
        source_type: row.source_type, source_id: row.source_id },
      after: { causal_status: 'ready', amount: input.amount } });
    await client.query('COMMIT');
    return { reviewed: true, id: row.id, amount: input.amount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { client.release(); }
}
