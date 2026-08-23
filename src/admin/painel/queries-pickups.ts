import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  pickupServicesTotalCents, type PickupService,
} from '../../shared/pickup-services.js';

export async function getMatrizRetiradas(dbPool: Pool = defaultPool): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT pr.order_id,pr.created_at,pr.contact_name AS customer_name,
            pr.contact_phone AS customer_phone,pr.source AS source_tag,live.status,
            live.payment_method,live.total_amount,live.retrieved_at,
            live.pickup_arrived_at,live.pickup_installation_started_at,
            live.pickup_services,COALESCE(items.rows,'[]'::jsonb) items,
            EXISTS (SELECT 1 FROM audit.events reservation
                     WHERE reservation.environment=live.environment
                       AND reservation.entity_id=live.id
                       AND reservation.event_type='matriz_galpao_reserved') has_stock_reservation
       FROM dashboard.pedidos_recentes pr
       JOIN commerce.orders live
         ON live.environment=pr.environment AND live.id=pr.order_id
       JOIN core.units unit
         ON unit.environment=live.environment AND unit.id=live.unit_id AND unit.slug='main'
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'product_name',product.product_name,'tire_size',spec.tire_size,
           'brand',product.brand,'quantity',item.quantity,'unit_price',item.unit_price,
           'pickup_service_code',item.pickup_service_code
         ) ORDER BY item.created_at) rows
           FROM commerce.order_items item
           LEFT JOIN commerce.products product
             ON product.environment=item.environment AND product.id=item.product_id
           LEFT JOIN commerce.tire_specs spec
             ON spec.environment=item.environment AND spec.product_id=item.product_id
          WHERE item.environment=live.environment AND item.order_id=live.id
       ) items ON true
      WHERE live.environment=$1 AND live.partner_order_id IS NULL
        AND live.fulfillment_mode='pickup' AND live.status<>'cancelled'
        AND (live.status='open' OR live.retrieved_at>=now()-interval '7 days')
        AND (live.status<>'open' OR EXISTS (
          SELECT 1 FROM audit.events reservation
           WHERE reservation.environment=live.environment
             AND reservation.entity_id=live.id
             AND reservation.event_type='matriz_galpao_reserved'))
      ORDER BY (live.status='open') DESC,live.created_at ASC
      LIMIT 300`,
    [env.FAREJADOR_ENV],
  );
  return result.rows;
}

export type MatrizPickupStage = 'waiting' | 'arrived' | 'installing';

export async function updateMatrizPickupStage(
  input: {
    order_id: string;
    stage: MatrizPickupStage;
    services: PickupService[];
    actor_label: string;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; stage: MatrizPickupStage }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query<{ order_id: string }>(
      `UPDATE commerce.orders pickup
          SET pickup_arrived_at=CASE
                WHEN $3='waiting' THEN NULL ELSE COALESCE(pickup_arrived_at,now()) END,
              pickup_installation_started_at=CASE
                WHEN $3='installing' THEN COALESCE(pickup_installation_started_at,now())
                ELSE NULL END,
              pickup_services=$4::jsonb,updated_at=now()
        WHERE pickup.environment=$1 AND pickup.id=$2
          AND pickup.partner_order_id IS NULL AND pickup.fulfillment_mode='pickup'
          AND pickup.status='open'
          AND EXISTS (SELECT 1 FROM core.units unit
                       WHERE unit.environment=pickup.environment
                         AND unit.id=pickup.unit_id AND unit.slug='main')
          AND EXISTS (SELECT 1 FROM audit.events reservation
                       WHERE reservation.environment=pickup.environment
                         AND reservation.entity_id=pickup.id
                         AND reservation.event_type='matriz_galpao_reserved')
        RETURNING pickup.id order_id`,
      [environment, input.order_id, input.stage, JSON.stringify(input.services)],
    );
    if (!updated.rows[0]) throw new Error('pickup_not_found');
    await client.query(
      `INSERT INTO audit.events (
         environment,domain,entity_table,entity_id,event_type,actor_label,payload_after
       ) VALUES ($1,'orders','commerce.orders',$2,'matriz_pickup_stage_changed',$3,$4::jsonb)`,
      [environment, input.order_id, input.actor_label, JSON.stringify({
        stage: input.stage,
        service_codes: input.services.map((service) => service.code),
        service_total_cents: pickupServicesTotalCents(input.services),
      })],
    );
    await client.query('COMMIT');
    return { order_id: input.order_id, stage: input.stage };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
