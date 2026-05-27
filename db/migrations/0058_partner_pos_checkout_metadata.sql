-- ============================================================
-- 0058_partner_pos_checkout_metadata.sql
-- Frente de caixa do parceiro: metadados de checkout.
--
-- Mantem a function atomica commerce.register_partner_local_order
-- inalterada. O TypeScript registra a venda via function e atualiza
-- notes/received_amount na mesma transacao.
-- ============================================================

ALTER TABLE commerce.partner_orders
  ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE commerce.partner_orders
  ADD COLUMN IF NOT EXISTS received_amount NUMERIC(10,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'partner_orders_received_amount_nonnegative'
      AND conrelid = 'commerce.partner_orders'::regclass
  ) THEN
    ALTER TABLE commerce.partner_orders
      ADD CONSTRAINT partner_orders_received_amount_nonnegative
      CHECK (received_amount IS NULL OR received_amount >= 0);
  END IF;
END $$;

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
  po.received_amount
FROM commerce.partner_orders po
LEFT JOIN commerce.partner_order_items poi
  ON poi.order_id = po.id AND poi.environment = po.environment
WHERE po.deleted_at IS NULL
GROUP BY po.id;

COMMENT ON VIEW commerce.partner_orders_full IS
  'Vendas do parceiro com items agregados em JSONB. Usado pelo portal parceiro pra listar Vendas recentes.';

ALTER VIEW commerce.partner_orders_full SET (security_invoker = true);
GRANT SELECT ON commerce.partner_orders_full TO farejador_partner_app;
