import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { recordIntegrityEvent } from './stage5-integrity.js';

export async function confirmMatrizTripFuelDivergence(
  input: {
    trip_id: string; actor_label: string; environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ trip_id: string; financial_status: 'reconciled'; approved_fuel_amount: number }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const actorLabel = input.actor_label.trim();
  if (!actorLabel) throw new Error('actor_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const trip = await client.query<{
      id: string; fuel_spent: string | null;
      fuel_divergence_confirmed_amount: string | null;
    }>(
      `SELECT id,fuel_spent::text,fuel_divergence_confirmed_amount::text
         FROM commerce.matriz_delivery_trips
        WHERE id=$2 AND environment=$1 AND status='closed' AND deleted_at IS NULL
        FOR UPDATE`,
      [environment, input.trip_id],
    );
    if (!trip.rows[0]) throw new Error('trip_not_found');
    const official = await client.query<{ amount: string }>(
      `SELECT COALESCE(sum(x.amount),0)::text AS amount FROM (
         SELECT DISTINCT e.id,e.amount
           FROM commerce.matriz_trip_receipts r
           JOIN commerce.matriz_expenses e
             ON e.id=r.ai_expense_id AND e.environment=r.environment
            AND e.deleted_at IS NULL AND e.category='combustivel'
          WHERE r.trip_id=$2 AND r.environment=$1
            AND r.workflow_status IN ('linked','legacy_linked')) x`,
      [environment, input.trip_id],
    );
    const approvedFuel = Number(official.rows[0]!.amount);
    const currentStatus = await client.query<{ financial_status: string }>(
      `SELECT commerce.matriz_trip_financial_status($2,$1) AS financial_status`,
      [environment, input.trip_id],
    );
    if (currentStatus.rows[0]!.financial_status === 'reconciled'
      && Number(trip.rows[0].fuel_divergence_confirmed_amount) === approvedFuel) {
      await client.query('COMMIT');
      return { trip_id: input.trip_id, financial_status: 'reconciled',
        approved_fuel_amount: approvedFuel };
    }
    if (currentStatus.rows[0]!.financial_status !== 'divergent') {
      throw new Error('trip_financial_divergence_not_found');
    }
    await client.query(
      `UPDATE commerce.matriz_delivery_trips
          SET fuel_divergence_confirmed_amount=$3,
              fuel_divergence_confirmed_at=now(),fuel_divergence_confirmed_by=$4
        WHERE id=$2 AND environment=$1`,
      [environment, input.trip_id, approvedFuel, actorLabel],
    );
    await recordIntegrityEvent(client, {
      environment, domain: 'matriz_logistics',
      entityTable: 'commerce.matriz_delivery_trips', entityId: input.trip_id,
      eventType: 'fuel_divergence_confirmed', actorLabel,
      idempotencyKey: `trip-fuel-divergence:${input.trip_id}:${approvedFuel.toFixed(2)}`,
      before: { fuel_spent: Number(trip.rows[0].fuel_spent ?? 0),
        approved_fuel_amount: approvedFuel },
      after: { financial_status: 'reconciled', approved_fuel_amount: approvedFuel },
    });
    await client.query('COMMIT');
    return { trip_id: input.trip_id, financial_status: 'reconciled',
      approved_fuel_amount: approvedFuel };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
