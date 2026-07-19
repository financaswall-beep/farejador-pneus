import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { MAIN_DELIVERY_GUARD } from '../painel/queries.js';
import type { EntregadorAuth } from './queries.js';

/** Nao entregue so reporta; cancelar e devolver estoque continuam sendo decisoes do dono. */
export async function reportEntregadorFail(
  auth: EntregadorAuth,
  input: { order_id: string; reason: string },
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; delivery_status: 'failed' }> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const observed = await client.query<{ trip_id: string }>(
      `SELECT o.trip_id FROM commerce.orders o
        JOIN commerce.matriz_delivery_trips t
          ON t.id=o.trip_id AND t.environment=o.environment
       WHERE o.id=$2 AND o.environment=$1 AND t.courier_collaborator_id=$3`,
      [environment, input.order_id, auth.collaboratorId],
    );
    const tripId = observed.rows[0]?.trip_id;
    if (!tripId) throw new Error('delivery_not_found');
    const trip = await client.query(
      `SELECT id FROM commerce.matriz_delivery_trips
        WHERE id=$2 AND environment=$1 AND courier_collaborator_id=$3
          AND status='open' AND deleted_at IS NULL FOR UPDATE`,
      [environment, tripId, auth.collaboratorId],
    );
    if (!trip.rows[0]) throw new Error('delivery_not_found');
    const result = await client.query<{ order_id: string }>(
      `UPDATE commerce.orders o
          SET delivery_status = 'failed', delivery_failure_reason = $3, updated_at = now()
        WHERE o.id = $2 AND o.environment = $1
          AND o.status <> 'cancelled' AND o.delivery_status NOT IN ('delivered','failed')
          AND o.trip_id=$5
          AND ${MAIN_DELIVERY_GUARD}
          AND o.trip_id IN (SELECT t.id FROM commerce.matriz_delivery_trips t
                             WHERE t.environment = $1 AND t.courier_collaborator_id = $4 AND t.status = 'open')
        RETURNING o.id AS order_id`,
      [environment, input.order_id, input.reason, auth.collaboratorId, tripId],
    );
    if (!result.rows[0]) throw new Error('delivery_not_found');
    await client.query('COMMIT');
    return { order_id: result.rows[0].order_id, delivery_status: 'failed' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
