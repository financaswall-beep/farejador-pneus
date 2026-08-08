-- 0164 - Reserva de estoque do galpao para pedidos abertos da Matriz.
--
-- Contrato novo (igual ao parceiro):
--   fisico     = quantity_on_hand
--   reservado  = quantity_reserved
--   disponivel = quantity_on_hand - quantity_reserved
--
-- Somente pedidos abertos do bot usam reserva. Vendas presenciais continuam
-- baixando o fisico imediatamente. Pedidos antigos permanecem no contrato
-- anterior, guiados pela trilha matriz_galpao_decrement, sem backfill arriscado.

ALTER TABLE commerce.wholesale_stock
  ADD COLUMN IF NOT EXISTS quantity_reserved INTEGER NOT NULL DEFAULT 0;

ALTER TABLE commerce.wholesale_stock
  DROP CONSTRAINT IF EXISTS wholesale_stock_reserved_check;

ALTER TABLE commerce.wholesale_stock
  ADD CONSTRAINT wholesale_stock_reserved_check CHECK (
    quantity_reserved >= 0
    AND quantity_on_hand >= quantity_reserved
  );

COMMENT ON COLUMN commerce.wholesale_stock.quantity_reserved IS
  '0164: pneus comprometidos com pedidos abertos da Matriz; disponivel = quantity_on_hand - quantity_reserved.';

ALTER TABLE commerce.orders
  ADD COLUMN IF NOT EXISTS retrieved_at TIMESTAMPTZ;

COMMENT ON COLUMN commerce.orders.retrieved_at IS
  '0164: momento em que uma retirada da Matriz foi entregue ao cliente e a reserva virou baixa fisica.';

CREATE INDEX IF NOT EXISTS orders_matriz_pickup_open_idx
  ON commerce.orders(environment, unit_id, created_at DESC)
  WHERE fulfillment_mode='pickup' AND status='open';

CREATE OR REPLACE FUNCTION commerce.block_reserved_wholesale_stock_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.quantity_reserved > 0 THEN
    RAISE EXCEPTION 'stock_reserved_cannot_delete:%', OLD.measure
      USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS wholesale_stock_block_reserved_delete
  ON commerce.wholesale_stock;
CREATE TRIGGER wholesale_stock_block_reserved_delete
  BEFORE DELETE ON commerce.wholesale_stock
  FOR EACH ROW EXECUTE FUNCTION commerce.block_reserved_wholesale_stock_delete();

-- A 0162 e um wrapper sobre a reconciliacao extensa da 0150. Mantemos os
-- acertos dela e sobrescrevemos apenas a chave que agora precisa aceitar um
-- pedido cancelado cuja reserva foi liberada antes de virar baixa fisica.
CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_reconciliation(
  p_environment env_t
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, finance, commerce, core, audit
AS $fn$
  SELECT finance.matriz_stage3_ledger_reconciliation_v0150(p_environment)
    || jsonb_build_object(
      'purchase_cancel_missing', (
        SELECT count(*) FROM commerce.wholesale_purchases p
         WHERE p.environment=p_environment AND p.status='cancelled'
           AND p.total_amount>0
           AND NOT EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=p.environment
                AND t.source_type='commerce.wholesale_purchase.cancel'
                AND t.source_id=p.id::text
           )
      ),
      'wholesale_cancel_missing', (
        SELECT count(*) FROM commerce.wholesale_orders o
         WHERE o.environment=p_environment AND o.status='cancelled'
           AND o.total_amount>0
           AND NOT EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=o.environment
                AND t.source_type='commerce.wholesale_order.revenue_cancel'
                AND t.source_id=o.id::text
           )
      ),
      'retail_cancel_missing', (
        SELECT count(*) FROM commerce.orders o
         JOIN core.units u
           ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
         WHERE o.environment=p_environment AND o.partner_order_id IS NULL
           AND o.status='cancelled' AND o.total_amount>0
           AND NOT EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=o.environment
                AND t.source_type='commerce.order.revenue_cancel'
                AND t.source_id=o.id::text
           )
      ),
      'retail_stock_decrement_missing', (
        SELECT count(*) FROM commerce.orders o
         JOIN core.units u
           ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
         WHERE o.environment=p_environment AND o.partner_order_id IS NULL
           AND o.status IN ('confirmed','paid','delivered','cancelled')
           AND NOT (
             o.status='cancelled'
             AND EXISTS (
               SELECT 1 FROM audit.events released
                WHERE released.environment=o.environment
                  AND released.entity_id=o.id
                  AND released.event_type='matriz_galpao_reservation_released'
             )
           )
           AND (
             o.status<>'cancelled'
             OR EXISTS (
               SELECT 1 FROM audit.events a
                WHERE a.environment=o.environment AND a.entity_id=o.id
                  AND a.event_type='matriz_galpao_return'
             )
             OR EXISTS (
               SELECT 1 FROM finance.matriz_ledger_transactions t
                WHERE t.environment=o.environment
                  AND t.source_type='commerce.order.cogs'
                  AND t.source_id=o.id::text
             )
             OR EXISTS (
               SELECT 1 FROM commerce.order_items i
                WHERE i.environment=o.environment AND i.order_id=o.id
                  AND i.matriz_unit_cost IS NOT NULL
             )
           )
           AND EXISTS (
             SELECT 1 FROM commerce.order_items i
             JOIN commerce.tire_specs s
               ON s.environment=i.environment AND s.product_id=i.product_id
              WHERE i.environment=o.environment AND i.order_id=o.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM audit.events a
              WHERE a.environment=o.environment AND a.entity_id=o.id
                AND a.event_type='matriz_galpao_decrement'
           )
      )
    );
$fn$;

COMMENT ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t) IS
  'Gate Etapa 3; 0164 distingue reserva liberada de baixa fisica ausente.';

REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
  FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
      FROM farejador_partner_app;
  END IF;
END
$security$;
