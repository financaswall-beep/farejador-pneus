import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { addStockPickingPositions, type StockPickingItem } from './stock-group-picking.js';
import {
  pickupServicesTotalCents, type PickupService, type PickupStage,
} from '../../shared/pickup-services.js';

export async function getMatrizRetiradas(dbPool: Pool = defaultPool, orderId?: string, includePositions = true) {
  const result = await dbPool.query<{ order_id: string; status: string; items: StockPickingItem[] }>(
    `SELECT pr.order_id,pr.created_at,pr.contact_name AS customer_name,
            pr.contact_phone AS customer_phone,pr.source AS source_tag,live.status,
            live.order_number,live.payment_method,live.total_amount,live.retrieved_at,live.fulfillment_not_before,
            live.pickup_ready_at,live.pickup_arrived_at,live.pickup_installation_started_at,
            live.pickup_services,COALESCE(items.rows,'[]'::jsonb) items,
            reservation.started_at IS NOT NULL AS has_stock_reservation,
            reservation.started_at AS reservation_started_at,
            commerce.pickup_reservation_deadline(live,NULL::commerce.partner_orders,$2) reservation_expires_at
       FROM dashboard.pedidos_recentes pr
       JOIN commerce.orders live
         ON live.environment=pr.environment AND live.id=pr.order_id
       JOIN core.units unit
         ON unit.environment=live.environment AND unit.id=live.unit_id AND unit.slug='main'
       LEFT JOIN LATERAL (
         SELECT min(event.created_at) started_at FROM audit.events event
          WHERE event.environment=live.environment AND event.entity_id=live.id
            AND event.entity_table='commerce.wholesale_stock'
            AND event.event_type='matriz_galpao_reserved'
       ) reservation ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'order_item_id',item.id,'product_name',product.product_name,'tire_size',spec.tire_size,
           'brand',product.brand,'tire_condition',product.tire_condition,
           'quantity',item.quantity,'unit_price',item.unit_price,
           'pickup_service_code',item.pickup_service_code
         ) ORDER BY item.created_at) rows
           FROM commerce.order_items item
           LEFT JOIN commerce.products product
             ON product.environment=item.environment AND product.id=item.product_id
           LEFT JOIN commerce.tire_specs spec
             ON spec.environment=item.environment AND spec.product_id=item.product_id
          WHERE item.environment=live.environment AND item.order_id=live.id
       ) items ON true
      WHERE live.environment=$1 AND live.partner_order_id IS NULL AND ($3::uuid IS NULL OR live.id=$3)
        AND live.fulfillment_mode='pickup' AND live.status<>'cancelled'
        AND (live.status='open' OR live.retrieved_at>=now()-interval '7 days')
        AND (live.status<>'open' OR reservation.started_at IS NOT NULL)
      ORDER BY (live.status='open') DESC,live.created_at ASC
      LIMIT 300`,
    [env.FAREJADOR_ENV, env.BOT_PICKUP_RESERVATION_HOURS, orderId ?? null],
  );
  if (includePositions) await addStockPickingPositions(dbPool, env.FAREJADOR_ENV, result.rows.filter(row => row.status === 'open'), 'open_pickup');
  return result.rows;
}

export type MatrizPickupStage = PickupStage;

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
    const updated = await client.query<{ order_id: string; changed: boolean; pickup_services: PickupService[] }>(
      `WITH target AS (
         SELECT live.id,live.pickup_ready_at,live.pickup_services
           FROM commerce.orders live
          WHERE live.environment=$1 AND live.id=$2
            AND live.partner_order_id IS NULL AND live.fulfillment_mode='pickup'
            AND live.status='open'
            AND EXISTS (SELECT 1 FROM core.units unit
                         WHERE unit.environment=live.environment AND unit.id=live.unit_id AND unit.slug='main')
            AND EXISTS (SELECT 1 FROM audit.events reservation
                         WHERE reservation.environment=live.environment AND reservation.entity_id=live.id
                           AND reservation.entity_table='commerce.wholesale_stock'
                           AND reservation.event_type='matriz_galpao_reserved')
            AND ($3<>'ready' OR (
              live.pickup_arrived_at IS NULL AND COALESCE(
                commerce.pickup_reservation_deadline(live,NULL::commerce.partner_orders,$5)>clock_timestamp(),true)
            ))
          FOR UPDATE OF live
       ), changed AS (
         UPDATE commerce.orders pickup
            SET pickup_ready_at=CASE WHEN $3='ready' THEN now() ELSE pickup.pickup_ready_at END,
                pickup_arrived_at=CASE WHEN $3='ready' THEN pickup.pickup_arrived_at
                  WHEN $3='waiting' THEN NULL ELSE COALESCE(pickup.pickup_arrived_at,now()) END,
                pickup_installation_started_at=CASE WHEN $3='ready' THEN pickup.pickup_installation_started_at
                  WHEN $3='installing' THEN COALESCE(pickup.pickup_installation_started_at,now()) ELSE NULL END,
                pickup_services=CASE WHEN $3='ready' THEN pickup.pickup_services ELSE $4::jsonb END,
                updated_at=now()
           FROM target
          WHERE pickup.id=target.id AND pickup.environment=$1
            AND ($3<>'ready' OR target.pickup_ready_at IS NULL)
          RETURNING pickup.id,pickup.pickup_services
       )
       SELECT id order_id,true changed,pickup_services FROM changed
       UNION ALL
       SELECT id order_id,false changed,pickup_services FROM target
        WHERE $3='ready' AND pickup_ready_at IS NOT NULL`,
      [environment, input.order_id, input.stage, JSON.stringify(input.services), env.BOT_PICKUP_RESERVATION_HOURS],
    );
    const row = updated.rows[0];
    if (!row) throw new Error('pickup_not_found');
    if (row.changed) {
      await client.query(
        `INSERT INTO audit.events (
           environment,domain,entity_table,entity_id,event_type,actor_label,payload_after
         ) VALUES ($1,'orders','commerce.orders',$2,'matriz_pickup_stage_changed',$3,$4::jsonb)`,
        [environment, input.order_id, input.actor_label, JSON.stringify({
          stage: input.stage,
          service_codes: row.pickup_services.map((service) => service.code),
          service_total_cents: pickupServicesTotalCents(row.pickup_services),
        })],
      );
    }
    await client.query('COMMIT');
    return { order_id: input.order_id, stage: input.stage };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
