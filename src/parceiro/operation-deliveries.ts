import { withPartnerContext } from './db.js';
import { readStoredTirePhoto, type StoredTirePhoto } from '../photos/storage.js';
import type { PartnerContext } from './auth.js';

export interface OperationDeliveryItem {
  quantity: number;
  label: string;
  tire_condition: string | null;
  order_item_id?: string;
  tire_size?: string | null;
  brand?: string | null;
  photo_request_id?: string | null;
}

export interface OperationDeliveryCard {
  order_id: string;
  order_status: string;
  created_at: string;
  customer_name: string | null;
  customer_avatar_url?: string | null;
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
  summary: { preparing: number; dispatched: number; delivered: number; returns: number };
  pagination: {
    view: 'active' | 'history';
    page: number;
    limit: number;
    total: number;
    has_more: boolean;
  };
}

type DeliveryRow = Omit<OperationDeliveryCard, 'total_amount' | 'items'> & {
  total_amount: string;
  total_count: string | number;
  total_preparing: string | number;
  total_dispatched: string | number;
  total_delivered: string | number;
  total_returns: string | number;
  items: Array<{
    order_item_id?: string;
    photo_request_id?: string | null;
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
  options: { view?: 'active' | 'history'; page?: number; limit?: number } = {},
): Promise<OperationDeliveriesPayload> {
  const view = options.view === 'history' ? 'history' : 'active';
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 100)));
  const offset = (page - 1) * limit;
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<DeliveryRow>(
      `SELECT pof.order_id, pof.status AS order_status, pof.created_at,
              pof.contact_name AS customer_name,
              pof.contact_phone AS customer_phone, pof.delivery_address,
              pof.delivery_status, pof.delivery_courier, pof.payment_method,
              pof.total_amount::text, pof.dispatched_at, pof.delivered_at,
              delivery_items.items, approved_photo.photo_request_id, customer.customer_avatar_url,
              count(*) OVER() AS total_count,
              count(*) FILTER (WHERE pof.delivery_status = 'pending')
                OVER() AS total_preparing,
              count(*) FILTER (WHERE pof.delivery_status = 'dispatched')
                OVER() AS total_dispatched,
              count(*) FILTER (WHERE pof.delivery_status = 'delivered')
                OVER() AS total_delivered,
              count(*) FILTER (WHERE pof.delivery_status = 'failed'
                                 AND pof.status <> 'cancelled')
                OVER() AS total_returns
         FROM commerce.partner_orders_full pof
         LEFT JOIN LATERAL (
           SELECT pc.customer_avatar_url FROM commerce.partner_conversations pc
            WHERE pc.environment=pof.environment AND pc.unit_id=pof.unit_id
              AND NULLIF(pc.customer_avatar_url,'') IS NOT NULL
              AND ((pof.customer_id IS NOT NULL AND pc.customer_id=pof.customer_id)
                OR ((pof.customer_id IS NULL OR pc.customer_id IS NULL) AND NULLIF(pof.contact_phone,'') IS NOT NULL
                  AND regexp_replace(pc.customer_identifier,'[^0-9]','','g')
                    = regexp_replace(pof.contact_phone,'[^0-9]','','g')))
            ORDER BY pc.last_message_at DESC NULLS LAST,pc.created_at DESC LIMIT 1
         ) customer ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'order_item_id',item.id,'item_name',item.item_name,'tire_size',item.tire_size,
             'brand',item.brand,'quantity',item.quantity,
             'tire_condition',COALESCE(item.tire_condition,photo.tire_condition),
             'photo_request_id',photo.id
           ) ORDER BY item.created_at,item.id) AS items
             FROM commerce.partner_order_items item
             LEFT JOIN LATERAL (
               SELECT pr.id,pr.tire_condition FROM commerce.photo_requests pr
                WHERE pr.environment=item.environment AND pr.order_item_id=item.id AND pr.unit_id=pof.unit_id
                  AND EXISTS (SELECT 1 FROM commerce.photo_request_blobs blob
                    WHERE blob.environment=pr.environment AND blob.photo_request_id=pr.id
                      AND blob.unit_id=pof.unit_id AND blob.deleted_at IS NULL)
                ORDER BY pr.created_at DESC LIMIT 1
             ) photo ON true
            WHERE item.environment=pof.environment AND item.order_id=pof.order_id
              AND item.pickup_service_code IS NULL
         ) delivery_items ON true
         LEFT JOIN LATERAL (
           SELECT pr.id AS photo_request_id
             FROM commerce.photo_requests pr
             JOIN commerce.partner_order_items poi_photo
               ON poi_photo.id = pr.order_item_id
              AND poi_photo.environment = pr.environment
            WHERE poi_photo.order_id = pof.order_id
              AND pr.environment = pof.environment
              AND pr.unit_id = pof.unit_id
              AND EXISTS (
                SELECT 1 FROM commerce.photo_request_blobs blob
                 WHERE blob.environment = pr.environment
                   AND blob.photo_request_id = pr.id AND blob.deleted_at IS NULL
              )
            ORDER BY pr.created_at DESC
            LIMIT 1
         ) approved_photo ON true
        WHERE pof.environment = $1 AND pof.unit_id = $2
          AND pof.fulfillment_mode = 'delivery'
          AND (
            ($3 = 'active' AND pof.status <> 'cancelled' AND (
              pof.delivery_status IS DISTINCT FROM 'delivered'
              OR pof.delivered_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
                                      AT TIME ZONE 'America/Sao_Paulo'
            ))
            OR ($3 = 'history' AND (pof.status = 'cancelled' OR pof.delivery_status = 'delivered'))
          )
        ORDER BY CASE pof.delivery_status
                   WHEN 'dispatched' THEN 0 WHEN 'pending' THEN 1
                   WHEN 'failed' THEN 2 ELSE 3 END,
                 COALESCE(pof.dispatched_at, pof.created_at) ASC
        LIMIT $4 OFFSET $5`,
      [ctx.environment, ctx.unitId, view, limit, offset],
    );

    const total = Number(result.rows[0]?.total_count ?? 0);
    const preparing = Number(result.rows[0]?.total_preparing ?? 0);
    const dispatched = Number(result.rows[0]?.total_dispatched ?? 0);
    const delivered = Number(result.rows[0]?.total_delivered ?? 0);
    const returns = Number(result.rows[0]?.total_returns ?? 0);
    const rows = result.rows.map(({ total_count: _totalCount,
      total_preparing: _totalPreparing, total_dispatched: _totalDispatched,
      total_delivered: _totalDelivered, total_returns: _totalReturns, ...row }) => ({
      ...row,
      total_amount: Number(row.total_amount),
      items: (row.items ?? []).map((item) => ({
        quantity: Number(item.quantity ?? 0),
        label: itemLabel(item),
        tire_condition: item.tire_condition ?? null,
        order_item_id: item.order_item_id,
        tire_size: item.tire_size ?? null,
        brand: item.brand ?? null,
        photo_request_id: item.photo_request_id ?? null,
      })),
    }));
    return {
      rows,
      summary: { preparing, dispatched, delivered, returns },
      pagination: { view, page, limit, total, has_more: offset + rows.length < total },
    };
  });
}

/** A imagem só sai se estiver anexada a um pedido de entrega da própria unidade. */
export async function getPartnerOperationDeliveryPhoto(
  ctx: PartnerContext,
  photoRequestId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const photo = await withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<StoredTirePhoto>(
      `SELECT blob.photo_bytes AS bytes, blob.photo_mime AS mime, blob.storage_path
         FROM commerce.photo_request_blobs blob
         JOIN commerce.photo_requests pr
           ON pr.id = blob.photo_request_id AND pr.environment = blob.environment
         JOIN commerce.partner_order_items poi
           ON poi.id = pr.order_item_id AND poi.environment = pr.environment
         JOIN commerce.partner_orders po
           ON po.id = poi.order_id AND po.environment = poi.environment
        WHERE blob.photo_request_id = $1 AND blob.deleted_at IS NULL
          AND blob.environment = $2 AND po.unit_id = $3
          AND pr.unit_id = po.unit_id AND blob.unit_id = po.unit_id
          AND po.fulfillment_mode = 'delivery' AND po.deleted_at IS NULL
        ORDER BY blob.created_at DESC
        LIMIT 1`,
      [photoRequestId, ctx.environment, ctx.unitId],
    );
    return result.rows[0];
  });
  return readStoredTirePhoto(photo);
}
