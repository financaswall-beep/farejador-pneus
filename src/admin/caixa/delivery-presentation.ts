import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { MAIN_DELIVERY_GUARD } from '../painel/queries-logistica-read.js';
import { getCustomerLeadAvatar } from '../painel/customer-lead-avatar.js';
import type { CaixaAuth } from './queries.js';

export interface DeliveryPresentation {
  order_id: string;
  conversation_id: string | null;
  delivery_failure_reason: string | null;
  items: Array<{ quantity: number; label: string; tire_condition: string | null;
    vehicle_type: 'car' | 'motorcycle' | null; tire_size: string | null; brand: string | null }>;
}

/** Somente fila da Matriz ou rota aberta do colaborador autenticado. Sem custo. */
export async function getDeliveryPresentation(
  auth: CaixaAuth, orderIds: string[], environment = env.FAREJADOR_ENV, db: Pool = defaultPool,
): Promise<Map<string, DeliveryPresentation>> {
  if (!orderIds.length) return new Map();
  const result = await db.query<DeliveryPresentation>(
    `SELECT o.id AS order_id, cv.id AS conversation_id, o.delivery_failure_reason,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'quantity', oi.quantity, 'label', COALESCE(p.product_name,'Pneu'),
              'tire_condition', p.tire_condition, 'vehicle_type', ts.vehicle_type,
              'tire_size', ts.tire_size, 'brand', p.brand) ORDER BY oi.created_at)
              FROM commerce.order_items oi
              LEFT JOIN commerce.products p ON p.id=oi.product_id AND p.environment=oi.environment
              LEFT JOIN commerce.tire_specs ts ON ts.product_id=p.id AND ts.environment=p.environment
              WHERE oi.order_id=o.id AND oi.environment=o.environment), '[]'::jsonb) AS items
       FROM commerce.orders o
       LEFT JOIN core.conversations cv ON cv.id=o.source_conversation_id AND cv.environment=o.environment
         AND cv.contact_id=o.contact_id AND cv.deleted_at IS NULL
      WHERE o.environment=$1 AND o.id=ANY($2::uuid[]) AND ${MAIN_DELIVERY_GUARD}
        AND o.status<>'cancelled'
        AND ((o.trip_id IS NULL AND o.delivery_status='pending') OR EXISTS (
          SELECT 1 FROM commerce.matriz_delivery_trips t
           WHERE t.id=o.trip_id AND t.environment=o.environment
             AND t.courier_collaborator_id=$3 AND t.status='open' AND t.deleted_at IS NULL
             AND o.delivery_status IN ('pending','dispatched','delivered','failed')))`,
    [environment, orderIds, auth.collaboratorId],
  );
  return new Map(result.rows.map(row => [row.order_id, row]));
}

export async function getDeliveryCustomerAvatar(auth: CaixaAuth, orderId: string): Promise<string | null> {
  const row = (await getDeliveryPresentation(auth, [orderId])).get(orderId);
  if (!row) throw new Error('delivery_not_found');
  if (!row.conversation_id) return null;
  try { return await getCustomerLeadAvatar(row.conversation_id, env.FAREJADOR_ENV); }
  catch (error) {
    if (error instanceof Error && error.message === 'lead_conversation_not_found') return null;
    throw error;
  }
}
