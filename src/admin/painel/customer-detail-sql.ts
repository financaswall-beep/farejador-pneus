/** Consultas somente de leitura. O cadastro é identificado por fonte + UUID, nunca por nome/telefone. */
export type CustomerDetailSource = 'chatwoot' | 'balcao' | 'parceiro' | 'atacado';

const conversationColumns = `cv.id::text AS lead_conversation_id,
  cv.chatwoot_account_id, cv.chatwoot_conversation_id`;
const lastConversation = `LEFT JOIN LATERAL (
  SELECT id,chatwoot_account_id,chatwoot_conversation_id,channel_type
  FROM core.conversations WHERE environment=c.environment AND contact_id=c.id AND deleted_at IS NULL
  ORDER BY COALESCE(last_activity_at,updated_at,started_at) DESC,id DESC LIMIT 1
) cv ON true`;

export const customerProfileSql: Record<CustomerDetailSource, string> = {
  chatwoot: `SELECT c.name,c.phone_e164 AS phone,c.email,c.created_at::text,
    COALESCE(NULLIF(cv.channel_type,''),NULLIF(c.channel_type,''),'Chatwoot') AS origin,
    NULL::text AS unit_name,NULL::text AS address,NULL::uuid AS unit_id,${conversationColumns}
    FROM core.contacts c ${lastConversation}
    WHERE c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL`,
  balcao: `SELECT c.name,c.phone_e164 AS phone,c.email,c.created_at::text,
    CASE c.source WHEN 'walkin' THEN 'Balcão' WHEN 'chatwoot_manual' THEN 'Chatwoot manual' ELSE 'ERP' END AS origin,
    'Matriz'::text AS unit_name,NULL::text AS address,NULL::uuid AS unit_id
    FROM commerce.customers c WHERE c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL`,
  parceiro: `SELECT c.name,c.phone,NULL::text AS email,c.created_at::text,
    'Loja parceira'::text AS origin,pu.display_name AS unit_name,c.unit_id,
    COALESCE(NULLIF(concat_ws(', ',NULLIF(c.address_street,''),NULLIF(c.address_number,''),
      NULLIF(c.address_neighborhood,''),NULLIF(c.address_city,'')),''),NULLIF(c.address,'')) AS address
    FROM commerce.partner_customers c
    JOIN network.partner_units pu ON pu.unit_id=c.unit_id AND pu.environment=c.environment AND pu.deleted_at IS NULL
    JOIN network.partners np ON np.id=pu.partner_id AND np.environment=c.environment AND np.deleted_at IS NULL
    WHERE c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL`,
  atacado: `SELECT c.name,c.phone,NULL::text AS email,c.created_at::text,
    'Atacado'::text AS origin,'Matriz'::text AS unit_name,NULL::text AS address,NULL::uuid AS unit_id
    FROM commerce.wholesale_customers c WHERE c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL`,
};

function retailOrders(source: 'chatwoot' | 'balcao'): string {
  return `SELECT o.id,o.order_number,o.total_amount,o.status,o.fulfillment_mode,o.payment_method,
    o.created_at,COALESCE(o.delivered_at,o.retrieved_at,o.created_at) AS occurred_at,
    o.delivery_address,u.name AS unit_name,
    (o.status IN ('confirmed','paid','delivered')
      AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered')
      AND (po.id IS NULL OR (po.status<>'cancelled' AND NOT po.awaiting_pickup
        AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')))) AS completed
    FROM commerce.orders o
    LEFT JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment
    LEFT JOIN commerce.partner_orders po ON po.id=o.partner_order_id AND po.environment=o.environment
    WHERE o.environment=$1 AND o.${source === 'chatwoot' ? 'contact_id' : 'customer_id'}=$2`;
}

const orderSources: Record<CustomerDetailSource, string> = {
  chatwoot: retailOrders('chatwoot'),
  balcao: retailOrders('balcao'),
  parceiro: `SELECT o.id,NULL::text AS order_number,o.total_amount,o.status,o.fulfillment_mode,o.payment_method,
    o.created_at,COALESCE(o.delivered_at,o.retrieved_at,o.created_at) AS occurred_at,
    o.delivery_address,u.name AS unit_name,
    (o.status<>'cancelled' AND NOT o.awaiting_pickup
      AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered')) AS completed
    FROM commerce.partner_orders o
    JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment
    WHERE o.environment=$1 AND o.customer_id=$2 AND o.unit_id=$5 AND o.deleted_at IS NULL`,
  atacado: `SELECT o.id,NULL::text AS order_number,
    COALESCE(o.settled_total_amount,o.total_amount) AS total_amount,o.status,
    'wholesale'::text AS fulfillment_mode,NULL::text AS payment_method,
    o.created_at,o.sold_at AS occurred_at,NULL::text AS delivery_address,'Matriz'::text AS unit_name,
    (o.status='confirmed' AND (o.partner_transfer_status IS NULL OR o.partner_transfer_status IN ('settled','received'))) AS completed
    FROM commerce.wholesale_orders o WHERE o.environment=$1 AND o.buyer_id=$2`,
};

const itemSources: Record<CustomerDetailSource, string> = {
  chatwoot: `SELECT oi.id,oi.quantity,oi.unit_price,p.product_name AS label
    FROM commerce.order_items oi
    JOIN commerce.products p ON p.id=oi.product_id AND p.environment=oi.environment
    WHERE oi.environment=$1 AND oi.order_id=page.id`,
  balcao: '',
  parceiro: `SELECT oi.id,oi.quantity,oi.unit_price,oi.item_name AS label
    FROM commerce.partner_order_items oi WHERE oi.environment=$1 AND oi.order_id=page.id`,
  atacado: `SELECT oi.id,oi.quantity,oi.unit_price,concat_ws(' ',oi.brand,oi.measure) AS label
    FROM commerce.wholesale_order_items oi WHERE oi.environment=$1 AND oi.order_id=page.id`,
};
itemSources.balcao = itemSources.chatwoot;

export function customerOrdersSql(source: CustomerDetailSource): string {
  return `WITH orders AS (${orderSources[source]}),
    page AS (SELECT * FROM orders ORDER BY occurred_at DESC,id DESC LIMIT $3 OFFSET $4)
    SELECT count(*)::int AS history_total,
      count(*) FILTER (WHERE completed)::int AS purchases,
      COALESCE(sum(total_amount) FILTER (WHERE completed),0)::float8 AS total_spent,
      COALESCE(avg(total_amount) FILTER (WHERE completed),0)::float8 AS avg_ticket,
      max(occurred_at) FILTER (WHERE completed)::text AS last_purchase_at,
      (SELECT delivery_address FROM orders WHERE status<>'cancelled' AND NULLIF(trim(delivery_address),'') IS NOT NULL
        ORDER BY created_at DESC,id DESC LIMIT 1) AS last_address,
      (SELECT unit_name FROM orders WHERE status<>'cancelled' AND unit_name IS NOT NULL
        ORDER BY created_at DESC,id DESC LIMIT 1) AS last_unit_name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',page.id,'order_number',COALESCE(page.order_number,upper(left(page.id::text,8))),
        'total_amount',page.total_amount,'status',page.status,'completed',page.completed,
        'fulfillment_mode',page.fulfillment_mode,'payment_method',page.payment_method,
        'occurred_at',page.occurred_at,'unit_name',page.unit_name,
        'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('label',i.label,'quantity',i.quantity,
          'unit_price',i.unit_price) ORDER BY i.id) FROM (${itemSources[source]}) i),'[]'::jsonb)
      ) ORDER BY page.occurred_at DESC,page.id DESC) FROM page),'[]'::jsonb) AS orders
    FROM orders`;
}
