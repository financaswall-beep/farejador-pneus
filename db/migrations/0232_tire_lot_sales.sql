BEGIN;

ALTER TABLE commerce.wholesale_orders ADD COLUMN is_lot_sale BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE commerce.wholesale_orders ADD COLUMN lot_sale_description TEXT;
ALTER TABLE commerce.wholesale_orders ADD COLUMN lot_sale_discount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(lot_sale_discount>=0);
ALTER TABLE commerce.wholesale_order_items ADD COLUMN tire_lot_id UUID;
ALTER TABLE commerce.wholesale_order_items ADD CONSTRAINT wholesale_item_tire_lot_fk
 FOREIGN KEY(environment,tire_lot_id) REFERENCES commerce.tire_lots(environment,id) ON DELETE RESTRICT;
ALTER TABLE commerce.wholesale_order_items ALTER COLUMN tire_condition DROP NOT NULL;
ALTER TABLE commerce.wholesale_order_items ADD CONSTRAINT wholesale_item_kind_check CHECK(
 (tire_lot_id IS NULL AND tire_condition IS NOT NULL) OR (tire_lot_id IS NOT NULL AND tire_condition IS NULL));

-- A negotiated total need not divide evenly by quantity. Keep full precision;
-- monetary totals and the frozen profit are still stored in cents.
ALTER TABLE commerce.wholesale_order_items DROP COLUMN line_total;
ALTER TABLE commerce.wholesale_order_items DROP COLUMN line_profit;
ALTER TABLE commerce.wholesale_order_items ALTER COLUMN unit_price TYPE NUMERIC;
ALTER TABLE commerce.wholesale_order_items ALTER COLUMN unit_cost TYPE NUMERIC;
ALTER TABLE commerce.wholesale_order_items ADD COLUMN line_total NUMERIC(12,2)
 GENERATED ALWAYS AS (quantity*unit_price) STORED;
ALTER TABLE commerce.wholesale_order_items ADD COLUMN line_profit NUMERIC(12,2)
 GENERATED ALWAYS AS ((unit_price-unit_cost)*quantity) STORED;
CREATE INDEX wholesale_order_items_tire_lot_idx ON commerce.wholesale_order_items(environment,tire_lot_id)
 WHERE tire_lot_id IS NOT NULL;

ALTER TABLE commerce.tire_lot_movements ADD COLUMN order_id UUID REFERENCES commerce.wholesale_orders(id) ON DELETE RESTRICT;
ALTER TABLE commerce.tire_lot_movements DROP CONSTRAINT tire_lot_movements_source_check;
ALTER TABLE commerce.tire_lot_movements ADD CHECK(source IN ('purchase_receipt','purchase_cancel','separation_in','sale','sale_cancel'));
ALTER TABLE commerce.tire_lot_movements ADD CHECK((source IN ('sale','sale_cancel'))=(order_id IS NOT NULL));
ALTER TABLE commerce.tire_lot_movements DROP CONSTRAINT tire_lot_movements_environment_lot_id_source_key;
CREATE UNIQUE INDEX tire_lot_movement_origin_uq ON commerce.tire_lot_movements(environment,lot_id,source) WHERE order_id IS NULL;
CREATE UNIQUE INDEX tire_lot_movement_sale_uq ON commerce.tire_lot_movements(environment,lot_id,source,order_id) WHERE order_id IS NOT NULL;

CREATE FUNCTION commerce.guard_tire_lot_sale_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_lot_sale boolean;
BEGIN
 IF TG_OP='DELETE' THEN
   IF OLD.tire_lot_id IS NOT NULL THEN RAISE EXCEPTION 'lot_sale_item_immutable'; END IF;
   RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.tire_lot_id IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'lot_sale_item_immutable';
 END IF;
 SELECT is_lot_sale INTO v_lot_sale FROM commerce.wholesale_orders WHERE id=NEW.order_id AND environment=NEW.environment;
 IF v_lot_sale IS DISTINCT FROM (NEW.tire_lot_id IS NOT NULL) THEN RAISE EXCEPTION 'lot_sale_item_kind_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tire_lot_sale_item_guard BEFORE INSERT OR UPDATE OR DELETE ON commerce.wholesale_order_items
 FOR EACH ROW EXECUTE FUNCTION commerce.guard_tire_lot_sale_item();
CREATE FUNCTION commerce.guard_tire_lot_sale_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.is_lot_sale IS DISTINCT FROM OLD.is_lot_sale THEN RAISE EXCEPTION 'lot_sale_kind_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tire_lot_sale_header_guard BEFORE UPDATE OF is_lot_sale ON commerce.wholesale_orders
 FOR EACH ROW EXECUTE FUNCTION commerce.guard_tire_lot_sale_header();
CREATE TRIGGER env_match_tire_lot_movement_order BEFORE INSERT ON commerce.tire_lot_movements
 FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','wholesale_orders','order_id');
REVOKE ALL ON FUNCTION commerce.guard_tire_lot_sale_item() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.guard_tire_lot_sale_header() FROM PUBLIC;
COMMIT;
