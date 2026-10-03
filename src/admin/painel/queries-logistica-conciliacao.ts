import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { beginIntegrityOperation, completeIntegrityOperation, moneyCents,
  operationFingerprint, recordIntegrityEvent, type MatrizEnvironment } from './stage5-integrity.js';

type Correction = {
  trip_id: string; amount: number; expected_amount: number | null; reason: string;
  idempotency_key: string; actor_label: string; environment?: MatrizEnvironment;
};
type CorrectionResult = { trip_id: string; fuel_spent: number; financial_status: string };

/** Corrige o relato operacional; despesas e lançamentos financeiros ficam preservados. */
export async function correctMatrizTripFuelAnnotation(input: Correction, db: Pool = pool): Promise<CorrectionResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim(), actor = input.actor_label.trim();
  const validMoney = (n: number) => Number.isFinite(n) && n >= 0 && n <= 99999
    && Math.abs(n * 100 - Math.round(n * 100)) < 0.000001;
  if (!validMoney(input.amount) || (input.expected_amount !== null && !validMoney(input.expected_amount))
    || reason.length < 3 || reason.length > 500 || !actor || actor.length > 120) {
    throw new Error('trip_fuel_correction_invalid');
  }
  const command = { trip_id: input.trip_id, amount: input.amount,
    expected_amount: input.expected_amount, reason, actor_label: actor };
  const operation = { environment, domain: 'logistics_fuel_annotation',
    idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint(command) };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const replay = await beginIntegrityOperation<CorrectionResult>(client, operation);
    if (replay.replayed) { await client.query('COMMIT'); return replay.result; }
    const trip = await client.query<{ fuel_spent: string | null }>(`SELECT fuel_spent::text
      FROM commerce.matriz_delivery_trips WHERE id=$2 AND environment=$1
      AND status='closed' AND deleted_at IS NULL FOR UPDATE`, [environment, input.trip_id]);
    if (!trip.rows[0]) throw new Error('trip_not_found');
    const previous = trip.rows[0].fuel_spent === null ? null : Number(trip.rows[0].fuel_spent);
    if ((previous === null) !== (input.expected_amount === null)
      || (previous !== null && moneyCents(previous) !== moneyCents(input.expected_amount!))) {
      throw new Error('trip_fuel_annotation_changed');
    }
    await client.query(`UPDATE commerce.matriz_delivery_trips SET fuel_spent=$3,
      fuel_divergence_confirmed_amount=NULL,fuel_divergence_confirmed_at=NULL,fuel_divergence_confirmed_by=NULL
      WHERE environment=$1 AND id=$2`, [environment, input.trip_id, input.amount]);
    const status = await client.query<{ financial_status: string }>(
      'SELECT commerce.matriz_trip_financial_status($2,$1) AS financial_status', [environment, input.trip_id]);
    const result = { trip_id: input.trip_id, fuel_spent: input.amount, financial_status: status.rows[0]!.financial_status };
    await recordIntegrityEvent(client, { environment, domain: 'matriz_logistics',
      entityTable: 'commerce.matriz_delivery_trips', entityId: input.trip_id,
      eventType: 'trip_fuel_annotation_corrected', actorLabel: actor, idempotencyKey: input.idempotency_key,
      before: { fuel_spent: previous }, after: { ...result, reason } });
    await completeIntegrityOperation(client, operation, 'commerce.matriz_delivery_trips', input.trip_id, result);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
