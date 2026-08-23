import { withPartnerContext } from './db.js';
import type { PartnerContext } from './auth.js';
import { moneyCents } from '../shared/catalog-pricing.js';
import {
  pickupServicesTotalCents, type PickupService,
} from '../shared/pickup-services.js';
import { materializePartnerPickupServices } from '../shared/pickup-service-persistence.js';
import { normalizePartnerText } from './partner-finance-input.js';

export async function getPartnerRetiradas(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT po.id order_id,po.created_at,po.customer_name,po.customer_phone,
              po.source_tag,po.status,po.payment_method,po.total_amount,
              po.awaiting_pickup,po.retrieved_at,po.pickup_arrived_at,
              po.pickup_installation_started_at,po.pickup_services,
              COALESCE(items.rows,'[]'::jsonb) items,
              (SELECT request.id FROM commerce.photo_requests request
                JOIN commerce.partner_order_items request_item
                  ON request_item.environment=request.environment
                 AND request_item.id=request.order_item_id
               WHERE request.environment=po.environment AND request_item.order_id=po.id
               ORDER BY request.created_at DESC LIMIT 1) photo_request_id
         FROM commerce.partner_orders po
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'item_name',item.item_name,'tire_size',item.tire_size,'brand',item.brand,
             'quantity',item.quantity,'unit_price',item.unit_price,
             'pickup_service_code',item.pickup_service_code
           ) ORDER BY item.created_at) rows
             FROM commerce.partner_order_items item
            WHERE item.environment=po.environment AND item.order_id=po.id
         ) items ON true
        WHERE po.environment=$1 AND po.unit_id=$2
          AND po.fulfillment_mode='pickup' AND po.status<>'cancelled'
          AND po.deleted_at IS NULL
          AND (po.awaiting_pickup OR po.retrieved_at>=now()-interval '7 days')
        ORDER BY po.awaiting_pickup DESC,po.created_at ASC
        LIMIT 300`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export type PartnerPickupStage = 'waiting' | 'arrived' | 'installing';

export async function updatePartnerPickupStage(
  ctx: PartnerContext,
  orderId: string,
  input: { stage: PartnerPickupStage; services: PickupService[] },
): Promise<{ order_id: string; stage: PartnerPickupStage }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const updated = await client.query<{ order_id: string }>(
      `UPDATE commerce.partner_orders
          SET pickup_arrived_at=CASE
                WHEN $4='waiting' THEN NULL ELSE COALESCE(pickup_arrived_at,now()) END,
              pickup_installation_started_at=CASE
                WHEN $4='installing' THEN COALESCE(pickup_installation_started_at,now())
                ELSE NULL END,
              pickup_services=$5::jsonb,updated_at=now()
        WHERE id=$1 AND environment=$2 AND unit_id=$3
          AND fulfillment_mode='pickup' AND awaiting_pickup
          AND status<>'cancelled' AND deleted_at IS NULL
        RETURNING id order_id`,
      [orderId, ctx.environment, ctx.unitId, input.stage, JSON.stringify(input.services)],
    );
    if (!updated.rows[0]) throw new Error('pickup_not_found');
    await client.query(
      `INSERT INTO audit.events (
         environment,domain,entity_table,entity_id,event_type,actor_label,payload_after
       ) VALUES ($1,'partner_orders','commerce.partner_orders',$2,
                 'partner_pickup_stage_changed',$3,$4::jsonb)`,
      [ctx.environment, orderId, `partner:${ctx.slug}`, JSON.stringify({
        unit_id: ctx.unitId, stage: input.stage,
        service_codes: input.services.map((service) => service.code),
        service_total_cents: pickupServicesTotalCents(input.services),
      })],
    );
    return { order_id: orderId, stage: input.stage };
  });
}

export class PickupAlreadyRetrievedError extends Error {
  readonly code = 'pickup_already_retrieved';
  constructor() { super('pickup_already_retrieved'); }
}

export interface MarkPickupRetrievedInput {
  payment_method: string;
  services?: PickupService[];
}

export async function markPartnerPickupRetrieved(
  ctx: PartnerContext,
  orderId: string,
  input: MarkPickupRetrievedInput,
): Promise<{ order_id: string; retrieved: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const existing = await client.query<{
      awaiting_pickup: boolean; status: string; total_amount: string;
      customer_id: string | null; customer_name: string | null;
      pickup_services: PickupService[];
    }>(
      `SELECT awaiting_pickup,status,total_amount,customer_id,customer_name,pickup_services
         FROM commerce.partner_orders
        WHERE id=$1 AND environment=$2 AND unit_id=$3
          AND fulfillment_mode='pickup' AND deleted_at IS NULL
        LIMIT 1 FOR UPDATE`,
      [orderId, ctx.environment, ctx.unitId],
    );
    if (existing.rowCount !== 1 || existing.rows[0]!.status === 'cancelled') {
      throw new Error('pickup_not_found');
    }
    const row = existing.rows[0]!;
    if (!row.awaiting_pickup) throw new PickupAlreadyRetrievedError();

    const services = input.services ?? row.pickup_services ?? [];
    await client.query(
      `UPDATE commerce.partner_orders
          SET pickup_arrived_at=COALESCE(pickup_arrived_at,now()),
              pickup_services=$4::jsonb,updated_at=now()
        WHERE id=$1 AND environment=$2 AND unit_id=$3`,
      [orderId, ctx.environment, ctx.unitId, JSON.stringify(services)],
    );
    const insertedServiceCents = await materializePartnerPickupServices(
      client, ctx.environment, orderId, services,
    );
    if (insertedServiceCents > 0) {
      await client.query(
        `UPDATE commerce.partner_orders
            SET total_amount=total_amount+$4::numeric,updated_at=now()
          WHERE id=$1 AND environment=$2 AND unit_id=$3`,
        [orderId, ctx.environment, ctx.unitId, (insertedServiceCents / 100).toFixed(2)],
      );
    }

    await client.query('SELECT commerce.complete_partner_pickup($1,$2)', [
      orderId, `partner:${ctx.slug}`,
    ]);
    await client.query(
      `UPDATE commerce.partner_orders
          SET awaiting_pickup=false,retrieved_at=now(),status='paid',updated_at=now(),
              operator_token_id=COALESCE(operator_token_id,$4)
        WHERE id=$1 AND environment=$2 AND unit_id=$3`,
      [orderId, ctx.environment, ctx.unitId, ctx.tokenId],
    );
    await client.query(
      `INSERT INTO finance.partner_receivables (
         environment,unit_id,customer_id,customer_name,description,source_tag,amount,
         due_date,status,received_at,payment_method,notes,created_by,idempotency_key,source_order_id
       ) VALUES ($1,$2,$3,$4,$5,'2w',$6,NULL,'received',now(),$7,$8,$9,$10,$11)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [ctx.environment, ctx.unitId, row.customer_id, row.customer_name,
       `Retirada ${orderId.slice(0, 8)}`,
       (moneyCents(Number(row.total_amount)) + insertedServiceCents) / 100,
       normalizePartnerText(input.payment_method),
       `Retirada paga no balcão — pedido ${orderId.slice(0, 8)}`,
       `partner:${ctx.slug}`, `order:${orderId}:pickup-receivable`, orderId],
    );
    await client.query(
      `INSERT INTO audit.events (
         environment,domain,entity_table,entity_id,event_type,actor_label,payload_after
       ) VALUES ($1,'partner_orders','commerce.partner_orders',$2,
                 'partner_pickup_retrieved',$3,$4::jsonb)`,
      [ctx.environment, orderId, `partner:${ctx.slug}`, JSON.stringify({
        unit_id: ctx.unitId, payment_method: normalizePartnerText(input.payment_method),
        service_codes: services.map((service) => service.code),
        service_total_cents: pickupServicesTotalCents(services),
      })],
    );
    return { order_id: orderId, retrieved: true };
  });
}
