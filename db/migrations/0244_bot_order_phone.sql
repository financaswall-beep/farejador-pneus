BEGIN;

-- Contato operacional do pedido, sem reescrever dados normalizados do Chatwoot.
-- Pedidos antigos permanecem sem snapshot; não inventar/corrigir telefones históricos.
ALTER TABLE commerce.orders ADD COLUMN customer_phone text
  CHECK (customer_phone IS NULL OR customer_phone ~ '^\+[1-9][0-9]{7,14}$');
COMMENT ON COLUMN commerce.orders.customer_phone IS
  'Telefone validado no fechamento do pedido. Snapshot E.164; não altera core.contacts.';

CREATE OR REPLACE VIEW dashboard.pedidos_recentes AS
SELECT o.environment,
    o.id AS order_id,
    o.created_at,
    o.unit_id,
    u.slug AS unit_slug,
    u.name AS unit_name,
    o.contact_id,
    o.customer_id,
    COALESCE(ct.name, cu.name, 'Cliente'::text) AS contact_name,
    COALESCE(o.customer_phone, po.customer_phone, ct.phone_e164, cu.phone_e164) AS contact_phone,
    o.source,
    o.status,
    o.payment_method,
    o.fulfillment_mode,
    o.delivery_address,
    o.total_amount,
    o.closed_by AS registered_by,
    o.closed_at AS registered_at,
    o.promoted_from_draft_id,
    (SELECT jsonb_agg(jsonb_build_object(
       'product_id',oi.product_id,
       'product_name',p.product_name,
       'product_code',p.product_code,
       'tire_size',ts.tire_size,
       'brand',p.brand,
       'tire_condition',oi.tire_condition,
       'quantity',oi.quantity,
       'unit_price',oi.unit_price,
       'discount_amount',oi.discount_amount,
       'subtotal',oi.quantity::numeric*oi.unit_price-oi.discount_amount
     ) ORDER BY oi.created_at)
       FROM commerce.order_items oi
       LEFT JOIN commerce.products p ON p.id=oi.product_id AND p.environment=oi.environment
       LEFT JOIN commerce.tire_specs ts ON ts.product_id=oi.product_id AND ts.environment=oi.environment
      WHERE oi.order_id=o.id AND oi.environment=o.environment) AS items,
    (o.partner_order_id IS NOT NULL) AS is_partner,
    po.status::text AS partner_status,
    po.delivery_status::text AS delivery_status,
    CASE WHEN o.partner_order_id IS NOT NULL
         THEN CASE WHEN po.status='paid' THEN 'pago' ELSE 'a_receber' END
         ELSE NULL END AS payment_status
FROM commerce.orders o
LEFT JOIN core.units u ON u.id=o.unit_id
LEFT JOIN core.contacts ct ON ct.id=o.contact_id AND ct.environment=o.environment
LEFT JOIN commerce.customers cu ON cu.id=o.customer_id AND cu.environment=o.environment
LEFT JOIN commerce.partner_orders po ON po.id=o.partner_order_id AND po.environment=o.environment;

COMMIT;
