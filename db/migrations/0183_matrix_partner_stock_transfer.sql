-- 0183 - Ponte transacional Matriz -> unidade parceira.
--
-- Uma venda de atacado para parceiro continua sendo registrada pela Matriz.
-- O mesmo commit cria uma compra pendente de recebimento na unidade parceira.
-- Acrescimos feitos depois da saida viram vendas complementares ligadas ao
-- pedido raiz: preservam o ledger imutavel e geram um novo recebimento pendente.

ALTER TABLE commerce.wholesale_orders
  ADD COLUMN IF NOT EXISTS parent_order_id UUID,
  ADD COLUMN IF NOT EXISTS partner_unit_id UUID;

ALTER TABLE commerce.wholesale_orders
  DROP CONSTRAINT IF EXISTS wholesale_orders_parent_fk;
ALTER TABLE commerce.wholesale_orders
  ADD CONSTRAINT wholesale_orders_parent_fk
  FOREIGN KEY (parent_order_id) REFERENCES commerce.wholesale_orders(id)
  ON DELETE RESTRICT;

ALTER TABLE commerce.wholesale_orders
  DROP CONSTRAINT IF EXISTS wholesale_orders_partner_unit_fk;
ALTER TABLE commerce.wholesale_orders
  ADD CONSTRAINT wholesale_orders_partner_unit_fk
  FOREIGN KEY (partner_unit_id) REFERENCES network.partner_units(id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS wholesale_orders_parent_idx
  ON commerce.wholesale_orders(environment,parent_order_id,sold_at)
  WHERE parent_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wholesale_orders_partner_unit_idx
  ON commerce.wholesale_orders(environment,partner_unit_id,sold_at DESC)
  WHERE partner_unit_id IS NOT NULL;

ALTER TABLE commerce.partner_purchases
  ADD COLUMN IF NOT EXISTS source_wholesale_order_id UUID;
ALTER TABLE commerce.partner_purchases
  DROP CONSTRAINT IF EXISTS partner_purchases_source_wholesale_order_fk;
ALTER TABLE commerce.partner_purchases
  ADD CONSTRAINT partner_purchases_source_wholesale_order_fk
  FOREIGN KEY (source_wholesale_order_id)
  REFERENCES commerce.wholesale_orders(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS partner_purchases_source_wholesale_order_uniq
  ON commerce.partner_purchases(environment,source_wholesale_order_id)
  WHERE source_wholesale_order_id IS NOT NULL;

ALTER TABLE commerce.partner_purchase_items
  ADD COLUMN IF NOT EXISTS source_wholesale_order_item_id UUID;
ALTER TABLE commerce.partner_purchase_items
  DROP CONSTRAINT IF EXISTS partner_purchase_items_source_wholesale_item_fk;
ALTER TABLE commerce.partner_purchase_items
  ADD CONSTRAINT partner_purchase_items_source_wholesale_item_fk
  FOREIGN KEY (source_wholesale_order_item_id)
  REFERENCES commerce.wholesale_order_items(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS partner_purchase_items_source_wholesale_item_uniq
  ON commerce.partner_purchase_items(environment,source_wholesale_order_item_id)
  WHERE source_wholesale_order_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION commerce.guard_wholesale_partner_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce,network
AS $$
DECLARE
  v_buyer_partner UUID;
  v_unit_partner UUID;
  v_parent RECORD;
BEGIN
  SELECT partner_id INTO v_buyer_partner
    FROM commerce.wholesale_customers
   WHERE id=NEW.buyer_id AND environment=NEW.environment AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wholesale_buyer_not_found' USING ERRCODE='23503';
  END IF;

  IF NEW.partner_unit_id IS NOT NULL THEN
    SELECT partner_id INTO v_unit_partner
      FROM network.partner_units
     WHERE id=NEW.partner_unit_id AND environment=NEW.environment
       AND status='active' AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'wholesale_partner_unit_not_active' USING ERRCODE='23514';
    END IF;
    IF v_buyer_partner IS NULL OR v_unit_partner IS DISTINCT FROM v_buyer_partner THEN
      RAISE EXCEPTION 'wholesale_partner_unit_buyer_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.parent_order_id IS NOT NULL THEN
    IF NEW.parent_order_id=NEW.id THEN
      RAISE EXCEPTION 'wholesale_addition_self_parent' USING ERRCODE='23514';
    END IF;
    SELECT buyer_id,partner_unit_id,parent_order_id,status INTO v_parent
      FROM commerce.wholesale_orders
     WHERE id=NEW.parent_order_id AND environment=NEW.environment;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'wholesale_parent_order_not_found' USING ERRCODE='23503';
    END IF;
    IF v_parent.status<>'confirmed' OR v_parent.parent_order_id IS NOT NULL THEN
      RAISE EXCEPTION 'wholesale_parent_order_not_open_root' USING ERRCODE='23514';
    END IF;
    IF v_parent.buyer_id IS DISTINCT FROM NEW.buyer_id THEN
      RAISE EXCEPTION 'wholesale_addition_buyer_mismatch' USING ERRCODE='23514';
    END IF;
    IF v_parent.partner_unit_id IS NOT NULL
       AND v_parent.partner_unit_id IS DISTINCT FROM NEW.partner_unit_id THEN
      RAISE EXCEPTION 'wholesale_addition_partner_unit_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wholesale_partner_link_guard
  ON commerce.wholesale_orders;
CREATE TRIGGER wholesale_partner_link_guard
  BEFORE INSERT OR UPDATE OF environment,buyer_id,parent_order_id,partner_unit_id,status
  ON commerce.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_wholesale_partner_link();

CREATE OR REPLACE FUNCTION commerce.guard_matrix_linked_partner_purchase()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce,network
AS $$
DECLARE
  v_source RECORD;
  v_bridge BOOLEAN := COALESCE(current_setting('app.matrix_partner_bridge',true),'')='on'
    AND session_user<>'farejador_partner_app';
BEGIN
  IF TG_OP='UPDATE' AND OLD.source_wholesale_order_id IS NOT NULL AND NOT v_bridge
     AND ROW(NEW.environment,NEW.unit_id,NEW.supplier_name,NEW.purchased_at,
             NEW.total_amount,NEW.payment_method,NEW.notes,NEW.created_by,
             NEW.idempotency_key,NEW.payment_status,NEW.payable_due_date,
             NEW.deleted_at,NEW.deleted_by,NEW.source_wholesale_order_id)
         IS DISTINCT FROM
         ROW(OLD.environment,OLD.unit_id,OLD.supplier_name,OLD.purchased_at,
             OLD.total_amount,OLD.payment_method,OLD.notes,OLD.created_by,
             OLD.idempotency_key,OLD.payment_status,OLD.payable_due_date,
             OLD.deleted_at,OLD.deleted_by,OLD.source_wholesale_order_id) THEN
    RAISE EXCEPTION 'matrix_linked_purchase_immutable' USING ERRCODE='23514';
  END IF;

  IF NEW.source_wholesale_order_id IS NULL THEN RETURN NEW; END IF;
  SELECT o.total_amount,o.sold_at,o.payment_status,o.due_date,pu.unit_id
    INTO v_source
    FROM commerce.wholesale_orders o
    JOIN network.partner_units pu
      ON pu.environment=o.environment AND pu.id=o.partner_unit_id
   WHERE o.environment=NEW.environment AND o.id=NEW.source_wholesale_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'matrix_linked_purchase_source_invalid' USING ERRCODE='23503';
  END IF;
  IF NEW.unit_id IS DISTINCT FROM v_source.unit_id THEN
    RAISE EXCEPTION 'matrix_linked_purchase_unit_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.total_amount IS DISTINCT FROM v_source.total_amount THEN
    RAISE EXCEPTION 'matrix_linked_purchase_total_mismatch:%:%',NEW.total_amount,v_source.total_amount
      USING ERRCODE='23514';
  END IF;
  IF NEW.purchased_at IS DISTINCT FROM v_source.sold_at THEN
    RAISE EXCEPTION 'matrix_linked_purchase_date_mismatch:%:%',NEW.purchased_at,v_source.sold_at
      USING ERRCODE='23514';
  END IF;
  IF NOT (
       (NEW.payment_status='paid_now' AND v_source.payment_status='paid')
       OR (NEW.payment_status='payable'
           AND NEW.payable_due_date IS NOT DISTINCT FROM v_source.due_date)
     ) THEN
    RAISE EXCEPTION 'matrix_linked_purchase_payment_mismatch:%:%:%:%',
      NEW.payment_status,NEW.payable_due_date,v_source.payment_status,v_source.due_date
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_linked_partner_purchase_guard
  ON commerce.partner_purchases;
CREATE TRIGGER matrix_linked_partner_purchase_guard
  BEFORE INSERT OR UPDATE ON commerce.partner_purchases
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_matrix_linked_partner_purchase();

CREATE OR REPLACE FUNCTION commerce.guard_matrix_linked_partner_purchase_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce
AS $$
DECLARE
  v_source RECORD;
  v_purchase_source UUID;
BEGIN
  SELECT source_wholesale_order_id INTO v_purchase_source
    FROM commerce.partner_purchases
   WHERE environment=NEW.environment AND id=NEW.purchase_id;
  IF NEW.source_wholesale_order_item_id IS NULL THEN
    IF v_purchase_source IS NOT NULL THEN
      RAISE EXCEPTION 'matrix_linked_purchase_item_source_required' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF v_purchase_source IS NULL THEN
    RAISE EXCEPTION 'matrix_linked_purchase_item_without_header_source' USING ERRCODE='23514';
  END IF;
  SELECT order_id,measure,brand,tire_condition,quantity,unit_price
    INTO v_source
    FROM commerce.wholesale_order_items
   WHERE environment=NEW.environment AND id=NEW.source_wholesale_order_item_id;
  IF NOT FOUND OR v_source.order_id IS DISTINCT FROM v_purchase_source THEN
    RAISE EXCEPTION 'matrix_linked_purchase_item_source_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.item_name IS DISTINCT FROM v_source.measure
     OR NEW.tire_size IS DISTINCT FROM v_source.measure
     OR NEW.brand IS DISTINCT FROM v_source.brand
     OR NEW.tire_condition IS DISTINCT FROM v_source.tire_condition
     OR NEW.quantity IS DISTINCT FROM v_source.quantity
     OR NEW.unit_cost IS DISTINCT FROM v_source.unit_price
     OR (NEW.received_quantity IS NOT NULL AND NEW.received_quantity>v_source.quantity) THEN
    RAISE EXCEPTION 'matrix_linked_purchase_item_values_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_linked_partner_purchase_item_guard
  ON commerce.partner_purchase_items;
CREATE TRIGGER matrix_linked_partner_purchase_item_guard
  BEFORE INSERT OR UPDATE ON commerce.partner_purchase_items
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_matrix_linked_partner_purchase_item();

CREATE OR REPLACE FUNCTION finance.guard_matrix_linked_partner_payable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,finance,commerce
AS $$
DECLARE
  v_purchase UUID;
  v_environment commerce.partner_purchases.environment%TYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    v_purchase := OLD.source_purchase_id;
    v_environment := OLD.environment;
  ELSE
    v_purchase := COALESCE(NEW.source_purchase_id,OLD.source_purchase_id);
    v_environment := NEW.environment;
  END IF;
  IF v_purchase IS NOT NULL AND EXISTS (
    SELECT 1 FROM commerce.partner_purchases p
     WHERE p.id=v_purchase AND p.environment=v_environment
       AND p.source_wholesale_order_id IS NOT NULL
  ) AND NOT (
    COALESCE(current_setting('app.matrix_partner_bridge',true),'')='on'
    AND session_user<>'farejador_partner_app'
  ) THEN
    RAISE EXCEPTION 'matrix_linked_payable_managed_by_matrix' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_linked_partner_payable_guard
  ON finance.partner_payables;
CREATE TRIGGER matrix_linked_partner_payable_guard
  BEFORE UPDATE OR DELETE ON finance.partner_payables
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matrix_linked_partner_payable();

COMMENT ON COLUMN commerce.wholesale_orders.parent_order_id IS
  '0183: pedido raiz quando esta venda e um acrescimo enviado depois da saida.';
COMMENT ON COLUMN commerce.wholesale_orders.partner_unit_id IS
  '0183: unidade parceira que recebera fisicamente os pneus; NULL para cliente so-atacado.';
COMMENT ON COLUMN commerce.partner_purchases.source_wholesale_order_id IS
  '0183: venda da Matriz que originou automaticamente esta entrada pendente.';
COMMENT ON COLUMN commerce.partner_purchase_items.source_wholesale_order_item_id IS
  '0183: linha exata despachada pela Matriz; recebido nunca pode superar enviado.';

DO $smoke$
BEGIN
  IF to_regclass('commerce.partner_purchases_source_wholesale_order_uniq') IS NULL
     OR to_regclass('commerce.partner_purchase_items_source_wholesale_item_uniq') IS NULL THEN
    RAISE EXCEPTION '0183: indices de correlacao ausentes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM commerce.partner_purchases p
     WHERE p.source_wholesale_order_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM commerce.wholesale_orders o
          WHERE o.environment=p.environment AND o.id=p.source_wholesale_order_id
       )
  ) THEN
    RAISE EXCEPTION '0183: compra parceira com origem atacado orfa';
  END IF;
END;
$smoke$;
