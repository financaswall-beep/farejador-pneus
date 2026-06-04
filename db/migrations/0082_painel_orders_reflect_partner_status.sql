-- 0082: telas da matriz refletem o status REAL do pedido de parceiro, não o espelho congelado.
--
-- Problema (auditoria 2026-06-04): o espelho commerce.orders fica eternamente status='open'
-- e payment_method 'a receber' para pedido de parceiro (o dono do ciclo de vida é
-- commerce.partner_orders). Toda tela que lia o status do espelho mentia:
--   * dashboard.pedidos_recentes: pedido entregue+pago aparecia "open" / "A receber".
--   * commerce.network_orders_unified: o mesmo pedido de parceiro aparecia 2x (espelho + dono).
--
-- Correção genérica (vale para QUALQUER parceiro, via partner_order_id — nada hard-coded):
--   * pedidos_recentes ganha colunas ADITIVAS (is_partner, partner_status, delivery_status,
--     payment_status) lidas do partner_orders; o front usa elas quando is_partner.
--   * network_orders_unified exclui do ramo "matriz" os espelhos que já têm partner_order_id.
--
-- Nota: colunas são ANEXADAS no fim (CREATE OR REPLACE VIEW não permite inserir no meio).

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
    COALESCE(ct.phone_e164, cu.phone_e164) AS contact_phone,
    o.source,
    o.status,
    o.payment_method,
    o.fulfillment_mode,
    o.delivery_address,
    o.total_amount,
    o.closed_by AS registered_by,
    o.closed_at AS registered_at,
    o.promoted_from_draft_id,
    ( SELECT jsonb_agg(jsonb_build_object('product_id', oi.product_id, 'product_name', p.product_name, 'product_code', p.product_code, 'quantity', oi.quantity, 'unit_price', oi.unit_price, 'discount_amount', oi.discount_amount, 'subtotal', oi.quantity::numeric * oi.unit_price - oi.discount_amount) ORDER BY oi.created_at) AS jsonb_agg
           FROM commerce.order_items oi
             LEFT JOIN commerce.products p ON p.id = oi.product_id AND p.environment::text = oi.environment::text
          WHERE oi.order_id = o.id AND oi.environment::text = o.environment::text) AS items,
    -- colunas ADITIVAS (status real do pedido de parceiro; o espelho fica 'open' pra sempre)
    (o.partner_order_id IS NOT NULL) AS is_partner,
    po.status::text AS partner_status,
    po.delivery_status::text AS delivery_status,
    CASE WHEN o.partner_order_id IS NOT NULL
         THEN (CASE WHEN po.status = 'paid' THEN 'pago' ELSE 'a_receber' END)
         ELSE NULL END AS payment_status
   FROM commerce.orders o
     LEFT JOIN core.units u ON u.id = o.unit_id
     LEFT JOIN core.contacts ct ON ct.id = o.contact_id AND ct.environment::text = o.environment::text
     LEFT JOIN commerce.customers cu ON cu.id = o.customer_id AND cu.environment::text = o.environment::text
     LEFT JOIN commerce.partner_orders po ON po.id = o.partner_order_id AND po.environment::text = o.environment::text;

CREATE OR REPLACE VIEW commerce.network_orders_unified AS
 SELECT 'matriz'::text AS source_table,
    o.id AS order_id,
    o.environment,
    o.unit_id,
    NULL::text AS unit_slug,
    'Matriz'::text AS unit_label,
    ct.name AS customer_name,
    ct.phone_e164 AS customer_phone,
    o.total_amount,
    o.status,
    o.payment_method,
    o.fulfillment_mode,
    o.delivery_address,
    o.source AS source_tag,
    o.closed_by AS registered_by,
    o.closed_at,
    o.created_at,
    o.updated_at
   FROM commerce.orders o
     LEFT JOIN core.contacts ct ON ct.id = o.contact_id AND ct.environment::text = o.environment::text
  WHERE o.partner_order_id IS NULL  -- não duplicar: o pedido de parceiro entra pelo ramo 'partner'
UNION ALL
 SELECT 'partner'::text AS source_table,
    po.id AS order_id,
    po.environment,
    po.unit_id,
    pu.slug AS unit_slug,
    pu.display_name AS unit_label,
    po.customer_name,
    po.customer_phone,
    po.total_amount,
    po.status,
    po.payment_method,
    po.fulfillment_mode,
    po.delivery_address,
    po.source_tag,
    po.closed_by AS registered_by,
    po.closed_at,
    po.created_at,
    po.updated_at
   FROM commerce.partner_orders po
     LEFT JOIN network.partner_units pu ON pu.id = po.unit_id AND pu.environment::text = po.environment::text AND pu.deleted_at IS NULL
  WHERE po.deleted_at IS NULL;
