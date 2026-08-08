import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  postMatrizRetailPaymentIfRealized, postMatrizRetailSaleFacts,
} from '../painel/matriz-ledger-retail-sales.js';
import { consumeMatrizGalpaoReservation } from '../../atendente-v2/matriz-stock-reservation.js';
import { MAIN_DELIVERY_GUARD } from '../painel/queries.js';
import type { EntregadorAuth } from './queries.js';

/** PENDENTE / SAIU / ENTREGUE. O pedido precisa estar na rota aberta do
 * entregador autenticado; as transições válidas ficam no próprio UPDATE. */
export async function setEntregadorDeliveryStatus(
  auth: EntregadorAuth,
  input: { order_id: string; status: 'pending' | 'dispatched' | 'delivered'; payment_method?: string | null },
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; delivery_status: string }> {
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
    const r = await client.query<{ order_id: string; delivery_status: string }>(
      `UPDATE commerce.orders o
          SET delivery_status = $3,
              delivery_courier = $6,
              dispatched_at = CASE
                WHEN $3 = 'dispatched' THEN COALESCE(o.dispatched_at, now())
                WHEN $3 = 'pending' THEN NULL
                ELSE o.dispatched_at
              END,
              delivered_at = CASE WHEN $3 = 'delivered' THEN now() ELSE o.delivered_at END,
              status = CASE WHEN $3 = 'delivered' THEN 'delivered' ELSE o.status END,
              payment_method = CASE WHEN $3 = 'delivered' THEN COALESCE(NULLIF($5, ''), o.payment_method) ELSE o.payment_method END,
              closed_at = CASE WHEN $3 = 'delivered' THEN COALESCE(o.closed_at, now()) ELSE o.closed_at END,
              closed_by = CASE WHEN $3 = 'delivered' THEN COALESCE(o.closed_by, $6) ELSE o.closed_by END,
              updated_at = now()
        WHERE o.id = $2 AND o.environment = $1 AND o.status <> 'cancelled'
          AND (($3 = 'dispatched' AND o.delivery_status = 'pending')
            OR ($3 = 'pending' AND o.delivery_status = 'dispatched')
            OR ($3 = 'delivered' AND o.delivery_status = 'dispatched'))
          AND o.trip_id=$7
          AND ${MAIN_DELIVERY_GUARD}
          AND o.trip_id IN (SELECT t.id FROM commerce.matriz_delivery_trips t
                             WHERE t.environment = $1 AND t.courier_collaborator_id = $4 AND t.status = 'open')
        RETURNING o.id AS order_id, o.delivery_status`,
      [environment, input.order_id, input.status, auth.collaboratorId,
       input.payment_method ?? null, auth.displayName, tripId],
    );
    if (!r.rows[0]) throw new Error('delivery_not_found');
    if (input.status === 'delivered') {
      await consumeMatrizGalpaoReservation(client, environment, input.order_id);
      await postMatrizRetailSaleFacts(client, environment, input.order_id);
      await postMatrizRetailPaymentIfRealized(
        client, environment, input.order_id, auth.displayName);
    }
    await client.query('COMMIT');
    return r.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Foto do pneu aprovado COM posse. A foto só sai quando pertence à mesma
 * conversa e ao mesmo produto de um pedido da rota aberta deste entregador. */
export async function getEntregadorProductPhotoImage(
  auth: EntregadorAuth,
  photoRequestId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const r = await dbPool.query<{ bytes: Buffer; mime: string }>(
    `SELECT b.photo_bytes AS bytes, b.photo_mime AS mime
       FROM commerce.photo_request_blobs b
       JOIN commerce.photo_requests pr
         ON pr.id = b.photo_request_id AND pr.environment = b.environment
       JOIN core.conversations cv
         ON cv.environment = pr.environment
        AND cv.chatwoot_conversation_id = pr.conversation_id
       JOIN commerce.orders o
         ON o.environment = cv.environment AND o.source_conversation_id = cv.id
       JOIN commerce.matriz_delivery_trips t
         ON t.id = o.trip_id AND t.environment = o.environment
      WHERE b.photo_request_id = $1 AND b.environment = $2
        AND t.courier_collaborator_id = $3
        AND t.status = 'open' AND t.deleted_at IS NULL
        AND o.status <> 'cancelled'
        AND o.delivery_status IN ('pending','dispatched','delivered')
        AND ${MAIN_DELIVERY_GUARD}
        AND EXISTS (
          SELECT 1
            FROM commerce.order_items oi_photo
            JOIN commerce.products p_photo ON p_photo.id = oi_photo.product_id
           WHERE oi_photo.order_id = o.id
             AND oi_photo.environment = o.environment
             AND p_photo.product_name = pr.tire_size
        )
      ORDER BY b.created_at DESC
      LIMIT 1`,
    [photoRequestId, environment, auth.collaboratorId],
  );
  return r.rows[0] ?? null;
}
