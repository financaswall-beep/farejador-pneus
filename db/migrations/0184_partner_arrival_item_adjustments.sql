-- 0184 - Acerto por pneu na chegada e carga em transito da Matriz.
--
-- Pneus recusados ainda estao no carro: nao voltam ao saldo disponivel da
-- Matriz ate o retorno fisico. Eles podem ser redirecionados a outra unidade
-- sem uma segunda baixa de estoque. O valor final usa somente o que ficou.

ALTER TABLE commerce.wholesale_orders
  ADD COLUMN IF NOT EXISTS dispatched_total_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS settled_total_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS partner_transfer_status TEXT;

ALTER TABLE commerce.wholesale_orders
  DROP CONSTRAINT IF EXISTS wholesale_orders_partner_transfer_status_check;
ALTER TABLE commerce.wholesale_orders
  ADD CONSTRAINT wholesale_orders_partner_transfer_status_check CHECK (
    partner_transfer_status IS NULL OR
    partner_transfer_status IN ('in_transit','settled','received')
  );
ALTER TABLE commerce.wholesale_orders
  DROP CONSTRAINT IF EXISTS wholesale_orders_partner_transfer_totals_check;
ALTER TABLE commerce.wholesale_orders
  ADD CONSTRAINT wholesale_orders_partner_transfer_totals_check CHECK (
    (partner_unit_id IS NULL AND partner_transfer_status IS NULL)
    OR
    (partner_unit_id IS NOT NULL
      AND partner_transfer_status IS NOT NULL
      AND dispatched_total_amount IS NOT NULL
      AND dispatched_total_amount>=0
      AND (
        (partner_transfer_status='in_transit' AND settled_total_amount IS NULL)
        OR
        (partner_transfer_status IN ('settled','received')
          AND settled_total_amount IS NOT NULL AND settled_total_amount>=0)
      ))
  );

ALTER TABLE commerce.wholesale_order_items
  ADD COLUMN IF NOT EXISTS accepted_quantity INTEGER;
ALTER TABLE commerce.wholesale_order_items
  DROP CONSTRAINT IF EXISTS wholesale_order_items_accepted_quantity_check;
ALTER TABLE commerce.wholesale_order_items
  ADD CONSTRAINT wholesale_order_items_accepted_quantity_check CHECK (
    accepted_quantity IS NULL OR
    (accepted_quantity>=0 AND accepted_quantity<=quantity)
  );

ALTER TABLE commerce.partner_purchase_items
  ADD COLUMN IF NOT EXISTS confirmed_quantity INTEGER;
ALTER TABLE commerce.partner_purchase_items
  DROP CONSTRAINT IF EXISTS partner_purchase_items_confirmed_quantity_check;
ALTER TABLE commerce.partner_purchase_items
  ADD CONSTRAINT partner_purchase_items_confirmed_quantity_check CHECK (
    confirmed_quantity IS NULL OR
    (confirmed_quantity>=0 AND confirmed_quantity<=quantity)
  );

CREATE TABLE IF NOT EXISTS commerce.matrix_partner_cargo_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  source_wholesale_order_item_id UUID NOT NULL
    REFERENCES commerce.wholesale_order_items(id) ON DELETE RESTRICT,
  measure TEXT NOT NULL,
  brand TEXT NOT NULL,
  tire_condition TEXT NOT NULL
    CHECK (tire_condition IN ('meia_vida','novo','remold')),
  unit_cost NUMERIC(14,6) NOT NULL CHECK (unit_cost>=0),
  quantity_loaded INTEGER NOT NULL CHECK (quantity_loaded>0),
  quantity_available INTEGER NOT NULL CHECK (
    quantity_available>=0 AND quantity_available<=quantity_loaded
  ),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','returned')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment,source_wholesale_order_item_id)
);

CREATE INDEX IF NOT EXISTS matrix_partner_cargo_available_idx
  ON commerce.matrix_partner_cargo_lots(environment,status,created_at,id)
  WHERE quantity_available>0;

CREATE TABLE IF NOT EXISTS commerce.matrix_partner_cargo_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  cargo_lot_id UUID NOT NULL
    REFERENCES commerce.matrix_partner_cargo_lots(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('rejected','allocated','returned')),
  quantity INTEGER NOT NULL CHECK (quantity>0),
  target_wholesale_order_id UUID
    REFERENCES commerce.wholesale_orders(id) ON DELETE RESTRICT,
  actor_label TEXT NOT NULL,
  reason TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment,idempotency_key)
);

CREATE INDEX IF NOT EXISTS matrix_partner_cargo_events_lot_idx
  ON commerce.matrix_partner_cargo_events(environment,cargo_lot_id,created_at,id);

ALTER TABLE commerce.wholesale_order_items
  ADD COLUMN IF NOT EXISTS source_cargo_lot_id UUID;
ALTER TABLE commerce.wholesale_order_items
  DROP CONSTRAINT IF EXISTS wholesale_order_items_source_cargo_lot_fk;
ALTER TABLE commerce.wholesale_order_items
  ADD CONSTRAINT wholesale_order_items_source_cargo_lot_fk
  FOREIGN KEY (source_cargo_lot_id)
  REFERENCES commerce.matrix_partner_cargo_lots(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS wholesale_order_items_source_cargo_lot_idx
  ON commerce.wholesale_order_items(environment,source_cargo_lot_id)
  WHERE source_cargo_lot_id IS NOT NULL;

-- Compatibilidade com qualquer linha criada entre 0183 e 0184.
UPDATE commerce.wholesale_orders o
   SET dispatched_total_amount=o.total_amount,
       settled_total_amount=CASE WHEN p.receipt_status='received' THEN o.total_amount ELSE NULL END,
       partner_transfer_status=CASE WHEN p.receipt_status='received' THEN 'received' ELSE 'in_transit' END
  FROM commerce.partner_purchases p
 WHERE o.environment=p.environment AND p.source_wholesale_order_id=o.id
   AND o.partner_unit_id IS NOT NULL AND o.partner_transfer_status IS NULL;

UPDATE commerce.wholesale_order_items i
   SET accepted_quantity=CASE WHEN o.partner_transfer_status='received' THEN i.quantity ELSE NULL END
  FROM commerce.wholesale_orders o
 WHERE o.environment=i.environment AND o.id=i.order_id
   AND o.partner_unit_id IS NOT NULL AND i.accepted_quantity IS NULL;

UPDATE commerce.partner_purchase_items i
   SET confirmed_quantity=CASE WHEN p.receipt_status='received' THEN i.quantity ELSE NULL END
  FROM commerce.partner_purchases p
 WHERE p.environment=i.environment AND p.id=i.purchase_id
   AND p.source_wholesale_order_id IS NOT NULL AND i.confirmed_quantity IS NULL;

CREATE OR REPLACE FUNCTION commerce.guard_matrix_partner_cargo_lot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce
AS $$
DECLARE
  v_source RECORD;
  v_allowed BOOLEAN := COALESCE(current_setting('app.matrix_partner_arrival',true),'')='on'
    AND session_user<>'farejador_partner_app';
BEGIN
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'matrix_partner_arrival_operation_required' USING ERRCODE='23514';
  END IF;
  SELECT i.environment,i.measure,i.brand,i.tire_condition,i.unit_cost,o.partner_unit_id
    INTO v_source
    FROM commerce.wholesale_order_items i
    JOIN commerce.wholesale_orders o
      ON o.environment=i.environment AND o.id=i.order_id
   WHERE i.id=NEW.source_wholesale_order_item_id;
  IF NOT FOUND OR v_source.environment IS DISTINCT FROM NEW.environment
     OR v_source.partner_unit_id IS NULL THEN
    RAISE EXCEPTION 'matrix_partner_cargo_source_invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.measure IS DISTINCT FROM v_source.measure
     OR NEW.brand IS DISTINCT FROM v_source.brand
     OR NEW.tire_condition IS DISTINCT FROM v_source.tire_condition
     OR NEW.unit_cost IS DISTINCT FROM v_source.unit_cost THEN
    RAISE EXCEPTION 'matrix_partner_cargo_identity_mismatch' USING ERRCODE='23514';
  END IF;
  IF (NEW.quantity_available>0 AND NEW.status<>'open')
     OR (NEW.quantity_available=0 AND NEW.status='open') THEN
    RAISE EXCEPTION 'matrix_partner_cargo_status_mismatch' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_partner_cargo_lot_guard
  ON commerce.matrix_partner_cargo_lots;
CREATE TRIGGER matrix_partner_cargo_lot_guard
  BEFORE INSERT OR UPDATE ON commerce.matrix_partner_cargo_lots
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_matrix_partner_cargo_lot();

DROP TRIGGER IF EXISTS matrix_partner_cargo_lot_environment_immutable
  ON commerce.matrix_partner_cargo_lots;
CREATE TRIGGER matrix_partner_cargo_lot_environment_immutable
  BEFORE UPDATE OF environment ON commerce.matrix_partner_cargo_lots
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS matrix_partner_cargo_event_environment_immutable
  ON commerce.matrix_partner_cargo_events;
CREATE TRIGGER matrix_partner_cargo_event_environment_immutable
  BEFORE UPDATE OF environment ON commerce.matrix_partner_cargo_events
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

CREATE OR REPLACE FUNCTION commerce.guard_matrix_partner_arrival_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce
AS $$
DECLARE
  v_allowed BOOLEAN := COALESCE(current_setting('app.matrix_partner_arrival',true),'')='on'
    AND session_user<>'farejador_partner_app';
BEGIN
  IF OLD.partner_unit_id IS NULL AND NEW.partner_unit_id IS NULL THEN RETURN NEW; END IF;
  IF ROW(NEW.partner_unit_id,NEW.partner_transfer_status,NEW.settled_total_amount)
     IS DISTINCT FROM
     ROW(OLD.partner_unit_id,OLD.partner_transfer_status,OLD.settled_total_amount)
     AND NOT v_allowed THEN
    RAISE EXCEPTION 'matrix_partner_arrival_operation_required' USING ERRCODE='23514';
  END IF;
  IF OLD.partner_transfer_status IS DISTINCT FROM NEW.partner_transfer_status
     AND NOT (
       (OLD.partner_transfer_status='in_transit' AND NEW.partner_transfer_status='settled')
       OR (OLD.partner_transfer_status='settled' AND NEW.partner_transfer_status='received')
     ) THEN
    RAISE EXCEPTION 'matrix_partner_transfer_transition_invalid:%:%',
      OLD.partner_transfer_status,NEW.partner_transfer_status USING ERRCODE='23514';
  END IF;
  IF NEW.partner_transfer_status IN ('settled','received') AND EXISTS (
    SELECT 1 FROM commerce.wholesale_order_items item
     WHERE item.environment=NEW.environment AND item.order_id=NEW.id
       AND item.accepted_quantity IS NULL
  ) THEN
    RAISE EXCEPTION 'matrix_partner_arrival_unconfirmed_item' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_partner_arrival_order_guard
  ON commerce.wholesale_orders;
CREATE TRIGGER matrix_partner_arrival_order_guard
  BEFORE UPDATE OF partner_unit_id,partner_transfer_status,settled_total_amount
  ON commerce.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_matrix_partner_arrival_order();

CREATE OR REPLACE FUNCTION commerce.guard_matrix_partner_arrival_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce
AS $$
DECLARE
  v_status TEXT;
  v_cargo RECORD;
  v_allowed BOOLEAN := COALESCE(current_setting('app.matrix_partner_arrival',true),'')='on'
    AND session_user<>'farejador_partner_app';
BEGIN
  SELECT partner_transfer_status INTO v_status
    FROM commerce.wholesale_orders
   WHERE environment=NEW.environment AND id=NEW.order_id;
  IF v_status IS NULL THEN RETURN NEW; END IF;
  IF (TG_OP='INSERT' AND (NEW.accepted_quantity IS NOT NULL OR NEW.source_cargo_lot_id IS NOT NULL))
     OR (TG_OP='UPDATE' AND ROW(NEW.accepted_quantity,NEW.source_cargo_lot_id)
       IS DISTINCT FROM ROW(OLD.accepted_quantity,OLD.source_cargo_lot_id)) THEN
    IF NOT v_allowed THEN
      RAISE EXCEPTION 'matrix_partner_arrival_operation_required' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.accepted_quantity IS NOT NULL
     AND NEW.accepted_quantity IS DISTINCT FROM OLD.accepted_quantity THEN
    RAISE EXCEPTION 'matrix_partner_accepted_quantity_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.source_cargo_lot_id IS NOT NULL
     AND NEW.accepted_quantity IS DISTINCT FROM NEW.quantity THEN
    RAISE EXCEPTION 'matrix_partner_allocated_cargo_must_be_accepted' USING ERRCODE='23514';
  END IF;
  IF NEW.source_cargo_lot_id IS NOT NULL THEN
    SELECT environment,measure,brand,tire_condition,unit_cost
      INTO v_cargo FROM commerce.matrix_partner_cargo_lots
     WHERE id=NEW.source_cargo_lot_id;
    IF NOT FOUND OR v_cargo.environment IS DISTINCT FROM NEW.environment
       OR v_cargo.measure IS DISTINCT FROM NEW.measure
       OR v_cargo.brand IS DISTINCT FROM NEW.brand
       OR v_cargo.tire_condition IS DISTINCT FROM NEW.tire_condition
       OR v_cargo.unit_cost IS DISTINCT FROM NEW.unit_cost THEN
      RAISE EXCEPTION 'matrix_partner_allocated_cargo_identity_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_partner_arrival_item_guard
  ON commerce.wholesale_order_items;
CREATE TRIGGER matrix_partner_arrival_item_guard
  BEFORE INSERT OR UPDATE OF accepted_quantity,source_cargo_lot_id
  ON commerce.wholesale_order_items
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_matrix_partner_arrival_item();

CREATE OR REPLACE FUNCTION commerce.guard_matrix_partner_cargo_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce
AS $$
DECLARE
  v_lot_environment public.env_t;
  v_target_environment public.env_t;
  v_allowed BOOLEAN := COALESCE(current_setting('app.matrix_partner_arrival',true),'')='on'
    AND session_user<>'farejador_partner_app';
BEGIN
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'matrix_partner_arrival_operation_required' USING ERRCODE='23514';
  END IF;
  SELECT environment INTO v_lot_environment
    FROM commerce.matrix_partner_cargo_lots WHERE id=NEW.cargo_lot_id;
  IF NOT FOUND OR NEW.environment IS DISTINCT FROM v_lot_environment THEN
    RAISE EXCEPTION 'matrix_partner_cargo_event_lot_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.target_wholesale_order_id IS NOT NULL THEN
    SELECT environment INTO v_target_environment
      FROM commerce.wholesale_orders WHERE id=NEW.target_wholesale_order_id;
    IF NOT FOUND OR NEW.environment IS DISTINCT FROM v_target_environment THEN
      RAISE EXCEPTION 'matrix_partner_cargo_event_target_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_partner_cargo_event_guard
  ON commerce.matrix_partner_cargo_events;
CREATE TRIGGER matrix_partner_cargo_event_guard
  BEFORE INSERT ON commerce.matrix_partner_cargo_events
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_matrix_partner_cargo_event();

CREATE OR REPLACE FUNCTION commerce.block_matrix_partner_cargo_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'matrix_partner_cargo_event_immutable' USING ERRCODE='23514';
END;
$$;

DROP TRIGGER IF EXISTS matrix_partner_cargo_event_immutable
  ON commerce.matrix_partner_cargo_events;
CREATE TRIGGER matrix_partner_cargo_event_immutable
  BEFORE UPDATE OR DELETE ON commerce.matrix_partner_cargo_events
  FOR EACH ROW EXECUTE FUNCTION commerce.block_matrix_partner_cargo_event_mutation();

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
  SELECT COALESCE(o.settled_total_amount,o.total_amount) total_amount,
         o.sold_at,o.payment_status,o.due_date,pu.unit_id
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

CREATE OR REPLACE FUNCTION commerce.guard_matrix_linked_partner_purchase_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce
AS $$
DECLARE
  v_source RECORD;
  v_purchase_source UUID;
  v_arrival BOOLEAN := COALESCE(current_setting('app.matrix_partner_arrival',true),'')='on'
    AND session_user<>'farejador_partner_app';
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
  SELECT i.order_id,i.measure,i.brand,i.tire_condition,i.quantity,i.unit_price,
         i.accepted_quantity,o.partner_transfer_status
    INTO v_source
    FROM commerce.wholesale_order_items i
    JOIN commerce.wholesale_orders o
      ON o.environment=i.environment AND o.id=i.order_id
   WHERE i.environment=NEW.environment AND i.id=NEW.source_wholesale_order_item_id;
  IF NOT FOUND OR v_source.order_id IS DISTINCT FROM v_purchase_source THEN
    RAISE EXCEPTION 'matrix_linked_purchase_item_source_mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.confirmed_quantity IS DISTINCT FROM OLD.confirmed_quantity
     AND NOT v_arrival THEN
    RAISE EXCEPTION 'matrix_partner_arrival_operation_required' USING ERRCODE='23514';
  END IF;
  IF NEW.item_name IS DISTINCT FROM v_source.measure
     OR NEW.tire_size IS DISTINCT FROM v_source.measure
     OR NEW.brand IS DISTINCT FROM v_source.brand
     OR NEW.tire_condition IS DISTINCT FROM v_source.tire_condition
     OR NEW.quantity IS DISTINCT FROM v_source.quantity
     OR NEW.unit_cost IS DISTINCT FROM v_source.unit_price
     OR (NEW.confirmed_quantity IS NOT NULL
         AND NEW.confirmed_quantity IS DISTINCT FROM v_source.accepted_quantity)
     OR (NEW.received_quantity IS NOT NULL
         AND NEW.received_quantity>COALESCE(NEW.confirmed_quantity,NEW.quantity)) THEN
    RAISE EXCEPTION 'matrix_linked_purchase_item_values_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.assert_partner_purchase_total()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=commerce,pg_catalog
AS $$
DECLARE
  v_environment public.env_t;
  v_purchase_id uuid;
  v_header numeric;
  v_items numeric;
BEGIN
  IF TG_TABLE_NAME='partner_purchases' THEN
    v_environment := COALESCE(NEW.environment,OLD.environment);
    v_purchase_id := COALESCE(NEW.id,OLD.id);
  ELSE
    v_environment := COALESCE(NEW.environment,OLD.environment);
    v_purchase_id := COALESCE(NEW.purchase_id,OLD.purchase_id);
  END IF;
  SELECT purchase.total_amount,
         COALESCE(sum(
           CASE WHEN purchase.source_wholesale_order_id IS NOT NULL
                THEN COALESCE(item.confirmed_quantity,item.quantity)
                ELSE item.quantity END * item.unit_cost
         ),0)
    INTO v_header,v_items
    FROM commerce.partner_purchases purchase
    LEFT JOIN commerce.partner_purchase_items item
      ON item.environment=purchase.environment AND item.purchase_id=purchase.id
   WHERE purchase.environment=v_environment AND purchase.id=v_purchase_id
   GROUP BY purchase.total_amount;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF round(v_header,2)<>round(v_items,2) THEN
    RAISE EXCEPTION 'partner_purchase_total_mismatch:%:%',v_header,v_items
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.mark_matrix_partner_transfer_received()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce
AS $$
BEGIN
  IF NEW.source_wholesale_order_id IS NOT NULL
     AND OLD.receipt_status='pending' AND NEW.receipt_status='received' THEN
    IF EXISTS (
      SELECT 1 FROM commerce.partner_purchase_items item
       WHERE item.environment=NEW.environment AND item.purchase_id=NEW.id
         AND item.received_quantity IS DISTINCT FROM item.confirmed_quantity
    ) THEN
      RAISE EXCEPTION 'matrix_shipment_requires_arrival_adjustment' USING ERRCODE='23514';
    END IF;
    PERFORM set_config('app.matrix_partner_arrival','on',true);
    UPDATE commerce.wholesale_orders
       SET partner_transfer_status='received'
     WHERE environment=NEW.environment AND id=NEW.source_wholesale_order_id
       AND partner_transfer_status='settled';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'matrix_partner_transfer_not_settled' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_partner_transfer_received
  ON commerce.partner_purchases;
CREATE TRIGGER matrix_partner_transfer_received
  AFTER UPDATE OF receipt_status ON commerce.partner_purchases
  FOR EACH ROW EXECUTE FUNCTION commerce.mark_matrix_partner_transfer_received();

CREATE OR REPLACE VIEW commerce.wholesale_buyer_summary
WITH (security_invoker = true) AS
  SELECT c.id AS buyer_id,c.environment,c.partner_id,c.name,c.phone,
         (c.partner_id IS NOT NULL) AS is_partner,
         count(o.id) AS orders_count,
         COALESCE(sum(COALESCE(o.settled_total_amount,o.total_amount)),0) AS total_bought,
         max(o.sold_at) AS last_purchase_at,
         (now()::date-max(o.sold_at)::date) AS days_since_last
    FROM commerce.wholesale_customers c
    LEFT JOIN commerce.wholesale_orders o
      ON o.buyer_id=c.id AND o.environment=c.environment AND o.status='confirmed'
     AND (o.partner_transfer_status IS NULL
          OR o.partner_transfer_status IN ('settled','received'))
   WHERE c.deleted_at IS NULL
   GROUP BY c.id,c.environment,c.partner_id,c.name,c.phone;

CREATE OR REPLACE FUNCTION finance.matriz_wholesale_itemized_commission(
  p_environment env_t,
  p_order_id UUID,
  p_rules JSONB
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
  SELECT round(COALESCE(sum(finance.operation_item_rule_amount(
    p_rules,'tire',CASE WHEN o.partner_transfer_status IN ('settled','received')
      THEN COALESCE(item.accepted_quantity,0) ELSE item.quantity END,
    item.unit_price*CASE WHEN o.partner_transfer_status IN ('settled','received')
      THEN COALESCE(item.accepted_quantity,0) ELSE item.quantity END
  )),0),2)
    FROM commerce.wholesale_order_items item
    JOIN commerce.wholesale_orders o
      ON o.environment=item.environment AND o.id=item.order_id
   WHERE item.environment=p_environment AND item.order_id=p_order_id
     AND (o.partner_transfer_status IS NULL
       OR o.partner_transfer_status IN ('settled','received'));
$function$;

REVOKE ALL ON FUNCTION finance.matriz_wholesale_itemized_commission(env_t,UUID,JSONB)
  FROM PUBLIC;

COMMENT ON TABLE commerce.matrix_partner_cargo_lots IS
  '0184: pneus recusados que continuam fisicamente no carro; nao fazem parte do saldo disponivel da Matriz.';
COMMENT ON COLUMN commerce.wholesale_order_items.accepted_quantity IS
  '0184: quantidade que ficou com o parceiro no acerto da chegada; NULL enquanto ainda em transito.';
COMMENT ON COLUMN commerce.partner_purchase_items.confirmed_quantity IS
  '0184: quantidade final acertada pela Matriz que o parceiro deve confirmar exatamente.';

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON commerce.matrix_partner_cargo_lots FROM farejador_partner_app;
    REVOKE ALL ON commerce.matrix_partner_cargo_events FROM farejador_partner_app;
  END IF;
END;
$permissions$;

DO $smoke$
BEGIN
  IF to_regclass('commerce.matrix_partner_cargo_lots') IS NULL
     OR to_regclass('commerce.matrix_partner_cargo_events') IS NULL THEN
    RAISE EXCEPTION '0184: tabelas da carga em transito ausentes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM commerce.matrix_partner_cargo_lots
     WHERE quantity_available<0 OR quantity_available>quantity_loaded
  ) THEN
    RAISE EXCEPTION '0184: saldo de carga invalido';
  END IF;
END;
$smoke$;
