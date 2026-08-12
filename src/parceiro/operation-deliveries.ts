import { withPartnerContext } from './db.js';
import type { PartnerContext } from './auth.js';

export interface OperationDeliveryItem {
  quantity: number;
  label: string;
  tire_condition: string | null;
}

export interface OperationDeliveryCard {
  order_id: string;
  created_at: string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  delivery_status: 'pending' | 'dispatched' | 'delivered' | 'failed';
  delivery_courier: string | null;
  payment_method: string | null;
  total_amount: number;
  dispatched_at: string | null;
  delivered_at: string | null;
  photo_request_id: string | null;
  items: OperationDeliveryItem[];
}

export interface OperationDeliveriesPayload {
  rows: OperationDeliveryCard[];
  summary: { preparing: number; dispatched: number; delivered: number };
}

type DeliveryRow = Omit<OperationDeliveryCard, 'total_amount' | 'items'> & {
  total_amount: string;
  items: Array<{
    quantity?: number | string;
    item_name?: string | null;
    tire_size?: string | null;
    brand?: string | null;
    tire_condition?: string | null;
  }> | null;
};

function itemLabel(item: NonNullable<DeliveryRow['items']>[number]): string {
  const brand = String(item.brand ?? '').trim();
  const size = String(item.tire_size ?? '').trim();
  if (brand && size) return `${brand} ${size}`;
  return size || String(item.item_name ?? '').trim() || 'Item do pedido';
}

/** Feed operacional: pendências antigas continuam visíveis; concluídas ficam só no dia. */
export async function getPartnerOperationDeliveries(
  ctx: PartnerContext,
): Promise<OperationDeliveriesPayload> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<DeliveryRow>(
      `SELECT pof.order_id, pof.created_at, pof.contact_name AS customer_name,
              pof.contact_phone AS customer_phone, pof.delivery_address,
              pof.delivery_status, pof.delivery_courier, pof.payment_method,
              pof.total_amount::text, pof.dispatched_at, pof.delivered_at,
              pof.items, approved_photo.photo_request_id
         FROM commerce.partner_orders_full pof
         LEFT JOIN LATERAL (
           SELECT pr.id AS photo_request_id
             FROM commerce.photo_requests pr
             JOIN commerce.partner_order_items poi_photo
               ON poi_photo.id = pr.order_item_id
              AND poi_photo.environment = pr.environment
            WHERE poi_photo.order_id = pof.order_id
              AND pr.environment = pof.environment
              AND EXISTS (
                SELECT 1 FROM commerce.photo_request_blobs blob
                 WHERE blob.environment = pr.environment
                   AND blob.photo_request_id = pr.id
              )
            ORDER BY pr.created_at DESC
            LIMIT 1
         ) approved_photo ON true
        WHERE pof.environment = $1 AND pof.unit_id = $2
          AND pof.fulfillment_mode = 'delivery'
          AND pof.status <> 'cancelled'
          AND (
            pof.delivery_status IS DISTINCT FROM 'delivered'
            OR pof.delivered_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
                                AT TIME ZONE 'America/Sao_Paulo'
          )
        ORDER BY CASE pof.delivery_status
                   WHEN 'dispatched' THEN 0 WHEN 'pending' THEN 1
                   WHEN 'failed' THEN 2 ELSE 3 END,
                 COALESCE(pof.dispatched_at, pof.created_at) ASC
        LIMIT 100`,
      [ctx.environment, ctx.unitId],
    );

    const rows = result.rows.map((row) => ({
      ...row,
      total_amount: Number(row.total_amount),
      items: (row.items ?? []).map((item) => ({
        quantity: Number(item.quantity ?? 0),
        label: itemLabel(item),
        tire_condition: item.tire_condition ?? null,
      })),
    }));
    return {
      rows,
      summary: {
        preparing: rows.filter((row) => row.delivery_status === 'pending' || row.delivery_status === 'failed').length,
        dispatched: rows.filter((row) => row.delivery_status === 'dispatched').length,
        delivered: rows.filter((row) => row.delivery_status === 'delivered').length,
      },
    };
  });
}

/** A imagem só sai se estiver anexada a um pedido de entrega da própria unidade. */
export async function getPartnerOperationDeliveryPhoto(
  ctx: PartnerContext,
  photoRequestId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ bytes: Buffer; mime: string }>(
      `SELECT blob.photo_bytes AS bytes, blob.photo_mime AS mime
         FROM commerce.photo_request_blobs blob
         JOIN commerce.photo_requests pr
           ON pr.id = blob.photo_request_id AND pr.environment = blob.environment
         JOIN commerce.partner_order_items poi
           ON poi.id = pr.order_item_id AND poi.environment = pr.environment
         JOIN commerce.partner_orders po
           ON po.id = poi.order_id AND po.environment = poi.environment
        WHERE blob.photo_request_id = $1
          AND blob.environment = $2 AND po.unit_id = $3
          AND po.fulfillment_mode = 'delivery' AND po.deleted_at IS NULL
        ORDER BY blob.created_at DESC
        LIMIT 1`,
      [photoRequestId, ctx.environment, ctx.unitId],
    );
    return result.rows[0] ?? null;
  });
}
