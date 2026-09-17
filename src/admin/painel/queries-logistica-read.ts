import { tripSelect } from './queries-logistica-trip-select.js';
// Leitura da Logistica da Matriz: entregas, rotas e memoria do resultado.
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { MatrizDeliveryRow, MatrizLogistica, MatrizTripRow } from './queries-logistica-types.js';
export type { MatrizDeliveryRow, MatrizLogistica, MatrizTripRow } from './queries-logistica-types.js';
export const MAIN_DELIVERY_GUARD = `
  o.fulfillment_mode = 'delivery'
  AND EXISTS (SELECT 1 FROM core.units u
               WHERE u.id = o.unit_id AND u.environment = o.environment AND u.slug = 'main')`;
/** A tela Logística num GET: entregas da main (abertas + últimas finalizadas) + rotas. */
export async function getMatrizLogistica(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizLogistica> {
  const deliverySelect = `
    SELECT o.id AS order_id, o.order_number,
           COALESCE(c.name,cu.name) AS customer_name,
           COALESCE(c.phone_e164,cu.phone_e164) AS customer_phone,
           o.delivery_address, o.total_amount::text, o.payment_method, o.status, o.delivery_status,
           o.delivery_courier, o.delivery_failure_reason, o.trip_id, o.created_at, o.dispatched_at, o.delivered_at,
           o.scheduled_delivery_date::text AS scheduled_raw,
           COALESCE(o.scheduled_delivery_date, ((o.created_at AT TIME ZONE 'America/Sao_Paulo')::date + 1))::text AS scheduled_date,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'quantity', oi.quantity,
                       'label', COALESCE(pr.product_name, 'item')) ORDER BY oi.created_at)
                       FROM commerce.order_items oi
                       LEFT JOIN commerce.products pr ON pr.id = oi.product_id
                      WHERE oi.order_id = o.id AND oi.environment = o.environment), '[]'::jsonb) AS items
      FROM commerce.orders o
      LEFT JOIN core.contacts c ON c.id = o.contact_id
      LEFT JOIN commerce.customers cu
        ON cu.id = o.customer_id AND cu.environment = o.environment
     WHERE o.environment = $1 AND ${MAIN_DELIVERY_GUARD}`;



  const [abertas, reportadas, finalizadas, rotasAbertas, rotasRecentes, couriers] = await Promise.all([
    dbPool.query<MatrizDeliveryRow>(
      `${deliverySelect} AND o.status <> 'cancelled' AND o.delivery_status IN ('pending','dispatched')
       ORDER BY scheduled_date ASC, o.created_at ASC`, [environment]),
    // o limbo do portal (failed SEM cancelar) — mesma régua do sino (queries-notificacoes)
    dbPool.query<MatrizDeliveryRow>(
      `${deliverySelect} AND o.status <> 'cancelled' AND o.delivery_status = 'failed'
       ORDER BY o.updated_at DESC`, [environment]),
    dbPool.query<MatrizDeliveryRow>(
      `${deliverySelect} AND (o.delivery_status = 'delivered' OR o.status = 'cancelled')
       AND (COALESCE(o.delivered_at,o.updated_at) AT TIME ZONE 'America/Sao_Paulo')::date
         >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 29
       ORDER BY COALESCE(o.delivered_at, o.updated_at) DESC`, [environment]),
    dbPool.query<MatrizTripRow>(
      `${tripSelect} AND t.status = 'open' ORDER BY t.started_at DESC`, [environment]),
    dbPool.query<MatrizTripRow>(
      `${tripSelect} AND t.status = 'closed'
       AND (COALESCE(t.ended_at,t.started_at) AT TIME ZONE 'America/Sao_Paulo')::date
         >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 29
       ORDER BY t.started_at DESC`, [environment]),
    dbPool.query<{ id: string; display_name: string }>(
      `SELECT mc.id,mc.display_name
         FROM network.matriz_collaborators mc
         LEFT JOIN network.matriz_collaborator_operation_permissions op
           ON op.environment=mc.environment AND op.collaborator_id=mc.id
        WHERE mc.environment=$1 AND mc.revoked_at IS NULL
          AND CASE WHEN op.collaborator_id IS NULL THEN mc.job='entregador'
                   ELSE op.allow_entregas END
        ORDER BY mc.display_name,mc.id`, [environment]),
  ]);
  return {
    abertas: abertas.rows,
    reportadas: reportadas.rows,
    finalizadas: finalizadas.rows,
    rotas_abertas: rotasAbertas.rows,
    rotas_recentes: rotasRecentes.rows,
    couriers: couriers.rows,
  };
}
