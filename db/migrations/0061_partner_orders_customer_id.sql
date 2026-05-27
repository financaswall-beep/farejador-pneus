-- ============================================================
-- 0061_partner_orders_customer_id.sql
-- Vinculo opcional entre venda local e cliente do parceiro.
-- ============================================================

ALTER TABLE commerce.partner_orders
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES commerce.partner_customers(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS env_match_partner_orders_customer ON commerce.partner_orders;
CREATE TRIGGER env_match_partner_orders_customer
  BEFORE INSERT OR UPDATE OF environment, customer_id ON commerce.partner_orders
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'partner_customers', 'customer_id');

CREATE INDEX IF NOT EXISTS partner_orders_customer_idx
  ON commerce.partner_orders(environment, unit_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE VIEW commerce.partner_orders_full AS
SELECT
  po.id              AS order_id,
  po.environment,
  po.unit_id,
  po.customer_name   AS contact_name,
  po.customer_phone  AS contact_phone,
  po.total_amount,
  po.status,
  po.payment_method,
  po.fulfillment_mode,
  po.delivery_address,
  po.source_tag,
  po.closed_by       AS registered_by,
  po.closed_at,
  po.created_at,
  po.updated_at,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'item_name', poi.item_name,
        'tire_size', poi.tire_size,
        'brand',     poi.brand,
        'quantity',  poi.quantity,
        'unit_price', poi.unit_price,
        'discount_amount', poi.discount_amount,
        'partner_stock_id', poi.partner_stock_id
      )
      ORDER BY poi.created_at
    ) FILTER (WHERE poi.id IS NOT NULL),
    '[]'::jsonb
  ) AS items,
  po.notes,
  po.received_amount,
  po.customer_cpf,
  po.customer_id
FROM commerce.partner_orders po
LEFT JOIN commerce.partner_order_items poi
  ON poi.order_id = po.id AND poi.environment = po.environment
WHERE po.deleted_at IS NULL
GROUP BY po.id;

ALTER VIEW commerce.partner_orders_full SET (security_invoker = true);
GRANT SELECT ON commerce.partner_orders_full TO farejador_partner_app;
