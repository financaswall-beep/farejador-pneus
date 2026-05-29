-- ============================================================
-- 0068_partner_delivery.sql
-- Gestao de entrega no portal parceiro: status, entregador e horarios.
--
-- Motivo:
--   Os borracheiros agora tambem saem para entregar. A venda ja guarda
--   fulfillment_mode='delivery' e delivery_address, mas faltava acompanhar
--   o estado operacional da entrega (pendente -> saiu -> entregue), quem
--   levou (entregador, texto livre) e os horarios.
--
-- O que esta migration faz:
--   1. Adiciona delivery_status, delivery_courier, dispatched_at, delivered_at
--      em commerce.partner_orders (so fazem sentido quando fulfillment_mode='delivery').
--   2. Indice parcial para listar entregas abertas por unidade.
--   3. Recria a view commerce.partner_orders_full expondo os 4 campos novos
--      (append no fim — CREATE OR REPLACE permite adicionar colunas ao final).
--
-- Aditiva e idempotente: nao altera dado existente (delivery_status default
-- 'pending'); o codigo antigo no ar nao referencia as colunas novas.
--
-- Assinatura: Claude (Opus 4.8), 2026-05-29
-- ============================================================

ALTER TABLE commerce.partner_orders
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'dispatched', 'delivered')),
  ADD COLUMN IF NOT EXISTS delivery_courier TEXT,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

COMMENT ON COLUMN commerce.partner_orders.delivery_status IS
  'Estado operacional da entrega (so relevante quando fulfillment_mode=delivery): '
  'pending | dispatched (saiu) | delivered.';
COMMENT ON COLUMN commerce.partner_orders.delivery_courier IS
  'Nome livre de quem leva/levou a entrega (sem cadastro de entregador).';

CREATE INDEX IF NOT EXISTS partner_orders_delivery_idx
  ON commerce.partner_orders (environment, unit_id, delivery_status)
  WHERE fulfillment_mode = 'delivery' AND deleted_at IS NULL;

CREATE OR REPLACE VIEW commerce.partner_orders_full AS
 SELECT po.id AS order_id,
    po.environment,
    po.unit_id,
    po.customer_name AS contact_name,
    po.customer_phone AS contact_phone,
    po.total_amount,
    po.status,
    po.payment_method,
    po.fulfillment_mode,
    po.delivery_address,
    po.source_tag,
    po.closed_by AS registered_by,
    po.closed_at,
    po.created_at,
    po.updated_at,
    COALESCE(jsonb_agg(jsonb_build_object(
      'item_name', poi.item_name, 'tire_size', poi.tire_size, 'brand', poi.brand,
      'quantity', poi.quantity, 'unit_price', poi.unit_price,
      'discount_amount', poi.discount_amount, 'partner_stock_id', poi.partner_stock_id
    ) ORDER BY poi.created_at) FILTER (WHERE poi.id IS NOT NULL), '[]'::jsonb) AS items,
    po.notes,
    po.received_amount,
    po.customer_cpf,
    po.customer_id,
    po.delivery_status,
    po.delivery_courier,
    po.dispatched_at,
    po.delivered_at
   FROM commerce.partner_orders po
     LEFT JOIN commerce.partner_order_items poi
       ON poi.order_id = po.id AND poi.environment::text = po.environment::text
  WHERE po.deleted_at IS NULL
  GROUP BY po.id;
