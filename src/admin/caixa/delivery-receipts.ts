import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { CaixaAuth } from './queries.js';

export interface CaixaDeliveryReceipt {
  receipt_id: string;
  workflow_status: string;
  has_image: boolean;
}

/** Apenas metadados das notas da rota aberta do próprio colaborador. */
export async function getCaixaDeliveryReceipts(
  auth: CaixaAuth,
  tripId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<CaixaDeliveryReceipt[]> {
  const result = await dbPool.query<CaixaDeliveryReceipt>(
    `SELECT r.id AS receipt_id,r.workflow_status,
            EXISTS(SELECT 1 FROM commerce.matriz_trip_receipt_blobs b
                    WHERE b.receipt_id=r.id AND b.environment=r.environment) AS has_image
       FROM commerce.matriz_trip_receipts r
       JOIN commerce.matriz_delivery_trips t ON t.id=r.trip_id AND t.environment=r.environment
      WHERE r.environment=$1 AND t.id=$2 AND t.courier_collaborator_id=$3
        AND t.status='open' AND t.deleted_at IS NULL
      ORDER BY r.created_at,r.id LIMIT 50`,
    [environment, tripId, auth.collaboratorId],
  );
  return result.rows;
}
