BEGIN;

ALTER TABLE commerce.wholesale_purchases ADD COLUMN purchase_kind TEXT NOT NULL
  DEFAULT 'catalog' CHECK (purchase_kind IN ('catalog','lot'));

-- Lots never enter the catalog or wholesale_stock, which supply the bot.
CREATE TABLE commerce.tire_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  lot_number BIGINT GENERATED ALWAYS AS IDENTITY,
  purchase_id UUID NOT NULL,
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity BETWEEN 1 AND 100000),
  accepted_quantity INTEGER CHECK (accepted_quantity BETWEEN 1 AND ordered_quantity),
  products_amount NUMERIC(12,2) NOT NULL CHECK (products_amount > 0),
  allocated_cost NUMERIC(12,2) NOT NULL CHECK (allocated_cost >= 0),
  quantity_on_hand INTEGER NOT NULL DEFAULT 0,
  quantity_reserved INTEGER NOT NULL DEFAULT 0,
  remaining_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (remaining_cost >= 0 AND remaining_cost <= allocated_cost),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment,id), UNIQUE (environment,purchase_id), UNIQUE (environment,lot_number),
  FOREIGN KEY (environment,purchase_id) REFERENCES commerce.wholesale_purchases(environment,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (quantity_on_hand BETWEEN 0 AND COALESCE(accepted_quantity,0)),
  CHECK (quantity_reserved BETWEEN 0 AND quantity_on_hand),
  CHECK (quantity_on_hand > 0 OR remaining_cost=0)
);

CREATE TABLE commerce.tire_lot_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  lot_id UUID NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('purchase_receipt','purchase_cancel')),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta<>0),
  cost_delta NUMERIC(12,2) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment,lot_id,source),
  FOREIGN KEY (environment,lot_id) REFERENCES commerce.tire_lots(environment,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX tire_lot_movements_date_idx ON commerce.tire_lot_movements(environment,occurred_at DESC);

-- Read-only reporting projection. The label is not a catalog measure.
CREATE VIEW commerce.wholesale_purchase_lines AS
 SELECT i.id,i.environment,i.purchase_id,i.measure,i.brand,i.tire_condition,
   i.quantity,i.ordered_quantity,i.accepted_quantity,i.unit_cost,i.line_total,
   i.allocated_cost,'catalog'::text item_kind
 FROM commerce.wholesale_purchase_items i
 UNION ALL
 SELECT l.id,l.environment,l.purchase_id,'Lote: '||l.description,NULL::text,NULL::text,
   l.ordered_quantity,l.ordered_quantity,l.accepted_quantity,
   l.products_amount/l.ordered_quantity,l.products_amount,l.allocated_cost,'lot'::text
 FROM commerce.tire_lots l;

CREATE OR REPLACE FUNCTION commerce.assert_wholesale_purchase_0208()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_environment env_t; v_purchase_id UUID;
  v_purchase commerce.wholesale_purchases%ROWTYPE;
  v_installments NUMERIC; v_allocated NUMERIC; v_items INTEGER; v_nulls INTEGER; v_lots INTEGER;
BEGIN
  IF TG_TABLE_NAME='wholesale_purchases' THEN
    v_environment:=NEW.environment; v_purchase_id:=NEW.id;
  ELSIF TG_OP='DELETE' THEN
    v_environment:=OLD.environment; v_purchase_id:=OLD.purchase_id;
  ELSE
    v_environment:=NEW.environment; v_purchase_id:=NEW.purchase_id;
  END IF;
  SELECT * INTO v_purchase FROM commerce.wholesale_purchases
    WHERE environment=v_environment AND id=v_purchase_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(amount),0) INTO v_installments FROM commerce.wholesale_purchase_installments
    WHERE environment=v_environment AND purchase_id=v_purchase_id;
  IF v_purchase.status<>'cancelled' AND v_purchase.payment_status='pending'
    AND v_purchase.total_amount>0 AND v_installments<>v_purchase.total_amount THEN
    RAISE EXCEPTION 'purchase_installments_do_not_close' USING ERRCODE='23514';
  END IF;
  SELECT count(*)::int,COALESCE(sum(allocated_cost),0),
    count(*) FILTER (WHERE accepted_quantity IS NULL)::int,
    count(*) FILTER (WHERE item_kind='lot')::int
    INTO v_items,v_allocated,v_nulls,v_lots
    FROM commerce.wholesale_purchase_lines WHERE environment=v_environment AND purchase_id=v_purchase_id;
  IF v_items=0 OR v_allocated<>v_purchase.total_amount THEN
    RAISE EXCEPTION 'purchase_items_do_not_close' USING ERRCODE='23514';
  END IF;
  IF (v_purchase.purchase_kind='lot' AND (v_lots<>1 OR v_items<>1))
    OR (v_purchase.purchase_kind='catalog' AND v_lots<>0) THEN
    RAISE EXCEPTION 'purchase_kind_items_mismatch' USING ERRCODE='23514';
  END IF;
  IF v_purchase.stock_applied AND v_nulls<>0 THEN
    RAISE EXCEPTION 'purchase_received_items_incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER tire_lots_purchase_integrity AFTER INSERT OR UPDATE OR DELETE ON commerce.tire_lots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.assert_wholesale_purchase_0208();
CREATE CONSTRAINT TRIGGER wholesale_purchase_kind_integrity AFTER UPDATE OF purchase_kind ON commerce.wholesale_purchases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.assert_wholesale_purchase_0208();
CREATE TRIGGER tire_lots_environment_immutable BEFORE UPDATE OF environment ON commerce.tire_lots
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
CREATE FUNCTION commerce.preserve_tire_lot_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'lot_movement_immutable'; END $$;
CREATE TRIGGER tire_lot_movement_immutable BEFORE UPDATE OR DELETE ON commerce.tire_lot_movements
  FOR EACH ROW EXECUTE FUNCTION commerce.preserve_tire_lot_movement();

ALTER TABLE commerce.tire_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.tire_lot_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.tire_lots,commerce.tire_lot_movements,commerce.wholesale_purchase_lines FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.preserve_tire_lot_movement() FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','partner_app','farejador_partner_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON commerce.tire_lots,commerce.tire_lot_movements,commerce.wholesale_purchase_lines FROM %I',r);
    END IF;
  END LOOP;
END $$;

-- Preserve the existing ledger checks and recognize reversals in each stock source.
ALTER FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
  RENAME TO matriz_stage3_ledger_reconciliation_v0229;
CREATE FUNCTION finance.matriz_stage3_ledger_reconciliation(p_environment env_t)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,finance,commerce,core,audit AS $$
 SELECT finance.matriz_stage3_ledger_reconciliation_v0229(p_environment)
   || jsonb_build_object('purchase_stock_reversal_missing', (
     SELECT count(*) FROM commerce.wholesale_purchases p
     WHERE p.environment=p_environment AND p.status='cancelled' AND p.stock_applied
       AND ((p.purchase_kind='catalog' AND NOT EXISTS (
         SELECT 1 FROM commerce.wholesale_stock_movements m
         WHERE m.environment=p.environment AND m.source='cancelamento_compra' AND m.ref=p.id::text))
       OR (p.purchase_kind='lot' AND NOT EXISTS (
         SELECT 1 FROM commerce.tire_lots l JOIN commerce.tire_lot_movements m
           ON m.environment=l.environment AND m.lot_id=l.id
         WHERE l.environment=p.environment AND l.purchase_id=p.id AND m.source='purchase_cancel')))
   ));
$$;
REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t) FROM PUBLIC;
COMMIT;
