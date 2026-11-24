import type { PoolClient } from 'pg';
import type { TireCondition } from '../shared/tire-condition.js';

export interface ReservationMovement {
  measure: string;
  brand: string;
  tire_condition: TireCondition;
  qty: number;
}

export async function hasMatrizReservationEvent(client: PoolClient, environment: 'prod' | 'test', orderId: string, eventType: string) {
  const result = await client.query(
    `SELECT 1 FROM audit.events
      WHERE environment=$1 AND entity_id=$2 AND event_type=$3 LIMIT 1`,
    [environment, orderId, eventType],
  );
  return result.rows.length > 0;
}

export async function reservationMovements(client: PoolClient, environment: 'prod' | 'test', orderId: string) {
  const result = await client.query<{ payload_after: { movements?: ReservationMovement[] } }>(
    `SELECT payload_after FROM audit.events
      WHERE environment=$1 AND entity_id=$2
        AND event_type IN ('matriz_galpao_reserved','matriz_galpao_reservation_adjusted')
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    [environment, orderId],
  );
  return result.rows[0]?.payload_after?.movements ?? [];
}
