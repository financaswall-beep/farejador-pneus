BEGIN;
-- No backfill: the category observed on a new operation must not rewrite history.
ALTER TABLE commerce.wholesale_stock ADD COLUMN vehicle_type text CHECK(vehicle_type IN ('motorcycle','car'));
ALTER TABLE commerce.wholesale_stock_movements ADD COLUMN vehicle_type text CHECK(vehicle_type IN ('motorcycle','car'));
ALTER TABLE commerce.wholesale_purchase_items ADD COLUMN vehicle_type text CHECK(vehicle_type IN ('motorcycle','car'));
ALTER TABLE commerce.order_items ADD COLUMN vehicle_type text CHECK(vehicle_type IN ('motorcycle','car'));
ALTER TABLE commerce.wholesale_order_items ADD COLUMN vehicle_type text CHECK(vehicle_type IN ('motorcycle','car','mixed'));
ALTER TABLE commerce.tire_lots ADD COLUMN vehicle_type text CHECK(vehicle_type IN ('motorcycle','car','mixed'));
ALTER TABLE ops.bot_stock_searches ADD COLUMN vehicle_type text CHECK(vehicle_type IN ('motorcycle','car'));
ALTER TABLE analytics.conversation_facts ADD COLUMN vehicle_type text CHECK(vehicle_type IN ('motorcycle','car'));

-- Exact variant only; never infer category from the shape of a tire size or its rim.
CREATE FUNCTION commerce.catalog_vehicle_type(e env_t,m text,b text,c text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN count(*)>0 AND count(*)=count(ts.vehicle_type)
   AND count(DISTINCT ts.vehicle_type)=1 THEN min(ts.vehicle_type) END
 FROM commerce.tire_specs ts JOIN commerce.products p ON p.environment=ts.environment AND p.id=ts.product_id
 WHERE p.environment=e AND p.deleted_at IS NULL AND p.product_type='tire'
   AND commerce.catalog_measure_identity(ts.tire_size)=commerce.catalog_measure_identity(m)
   AND (b IS NULL OR commerce.catalog_brand_identity(p.brand)=commerce.catalog_brand_identity(b))
   AND (c IS NULL OR p.tire_condition=c)
$$;
CREATE FUNCTION commerce.stock_vehicle_type(e env_t,m text,b text,c text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE(commerce.catalog_vehicle_type(e,m,b,c),
   (SELECT CASE WHEN count(*)=count(s.vehicle_type) AND count(DISTINCT s.vehicle_type)=1
     THEN min(s.vehicle_type) END FROM commerce.wholesale_stock s WHERE s.environment=e
       AND commerce.catalog_measure_identity(s.measure)=commerce.catalog_measure_identity(m)
       AND (b IS NULL OR commerce.catalog_brand_identity(s.brand)=commerce.catalog_brand_identity(b))
       AND (c IS NULL OR s.tire_condition=c)))
$$;

CREATE FUNCTION commerce.capture_operation_vehicle_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE resolved text; doc jsonb := to_jsonb(NEW);
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME<>'wholesale_stock' THEN
   IF NEW.vehicle_type IS DISTINCT FROM OLD.vehicle_type THEN RAISE EXCEPTION 'operation_vehicle_type_immutable'; END IF;
   RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='order_items' THEN
   SELECT ts.vehicle_type INTO resolved FROM commerce.tire_specs ts
     WHERE ts.environment=NEW.environment AND ts.product_id=NEW.product_id;
 ELSIF TG_TABLE_NAME='tire_lots' THEN
   IF NEW.origin_type='separation' THEN
     SELECT commerce.stock_vehicle_type(s.environment,s.measure,s.brand,s.tire_condition) INTO resolved
       FROM commerce.wholesale_stock s WHERE s.environment=NEW.environment AND s.id=NEW.origin_stock_id;
   END IF;
 ELSIF TG_TABLE_NAME='wholesale_order_items' AND doc->>'tire_lot_id' IS NOT NULL THEN
   SELECT l.vehicle_type INTO resolved FROM commerce.tire_lots l
     WHERE l.environment=NEW.environment AND l.id=(doc->>'tire_lot_id')::uuid;
 ELSE
   resolved := commerce.stock_vehicle_type(NEW.environment,NEW.measure,NEW.brand,NEW.tire_condition);
 END IF;
 IF NEW.vehicle_type IS NOT NULL AND resolved IS NOT NULL AND NEW.vehicle_type<>resolved THEN
   RAISE EXCEPTION 'operation_vehicle_type_conflict';
 END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='wholesale_stock' AND OLD.vehicle_type IS NOT NULL
   AND NEW.vehicle_type IS DISTINCT FROM OLD.vehicle_type THEN
   RAISE EXCEPTION 'stock_vehicle_type_conflict';
 END IF;
 NEW.vehicle_type := COALESCE(NEW.vehicle_type,resolved);
 RETURN NEW;
END $$;
CREATE TRIGGER vehicle_type_capture BEFORE INSERT OR UPDATE ON commerce.wholesale_stock
 FOR EACH ROW EXECUTE FUNCTION commerce.capture_operation_vehicle_type();
CREATE TRIGGER vehicle_type_capture BEFORE INSERT OR UPDATE ON commerce.wholesale_stock_movements
 FOR EACH ROW EXECUTE FUNCTION commerce.capture_operation_vehicle_type();
CREATE TRIGGER vehicle_type_capture BEFORE INSERT OR UPDATE ON commerce.wholesale_purchase_items
 FOR EACH ROW EXECUTE FUNCTION commerce.capture_operation_vehicle_type();
CREATE TRIGGER vehicle_type_capture BEFORE INSERT OR UPDATE ON commerce.order_items
 FOR EACH ROW EXECUTE FUNCTION commerce.capture_operation_vehicle_type();
CREATE TRIGGER vehicle_type_capture BEFORE INSERT OR UPDATE ON commerce.wholesale_order_items
 FOR EACH ROW EXECUTE FUNCTION commerce.capture_operation_vehicle_type();
CREATE TRIGGER vehicle_type_capture BEFORE INSERT OR UPDATE ON commerce.tire_lots
 FOR EACH ROW EXECUTE FUNCTION commerce.capture_operation_vehicle_type();

CREATE FUNCTION analytics.capture_demand_vehicle_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m text; b text; c text;
BEGIN
 IF TG_TABLE_SCHEMA='ops' THEN
   m:=NEW.measure; b:=NEW.filters->>'marca'; c:=NEW.filters->>'condicao_pneu';
 ELSE
   IF NEW.fact_key<>'medida_consultada' OR jsonb_typeof(NEW.fact_value)<>'string' THEN RETURN NEW; END IF;
   m:=NEW.fact_value#>>'{}';
 END IF;
 -- Snapshot is determined by catalog evidence, not a model-supplied classification.
 NEW.vehicle_type:=commerce.catalog_vehicle_type(NEW.environment,m,b,c);
 -- An explicitly classified measure draft can describe demand before a SKU exists.
 -- An existing ambiguous/unclassified SKU takes precedence: never guess its type.
 IF NEW.vehicle_type IS NULL AND NOT EXISTS (
   SELECT 1 FROM commerce.products p JOIN commerce.tire_specs ts ON ts.environment=p.environment AND ts.product_id=p.id
   WHERE p.environment=NEW.environment AND p.deleted_at IS NULL AND p.product_type='tire'
     AND commerce.catalog_measure_identity(ts.tire_size)=commerce.catalog_measure_identity(m)
 ) THEN
   SELECT r.vehicle_type INTO NEW.vehicle_type FROM commerce.catalog_measure_registrations r
     WHERE r.environment=NEW.environment AND commerce.catalog_measure_identity(r.measure)=commerce.catalog_measure_identity(m);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER vehicle_type_capture BEFORE INSERT ON ops.bot_stock_searches
 FOR EACH ROW EXECUTE FUNCTION analytics.capture_demand_vehicle_type();
CREATE TRIGGER vehicle_type_capture BEFORE INSERT ON analytics.conversation_facts
 FOR EACH ROW EXECUTE FUNCTION analytics.capture_demand_vehicle_type();

-- Keep stock-only classification and the catalog consistent without reclassifying transactions.
CREATE FUNCTION commerce.guard_catalog_stock_vehicle_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM commerce.products p JOIN commerce.wholesale_stock s
   ON s.environment=p.environment AND commerce.catalog_brand_identity(s.brand)=commerce.catalog_brand_identity(p.brand)
     AND s.tire_condition=p.tire_condition
   WHERE p.environment=NEW.environment AND p.id=NEW.product_id AND s.vehicle_type IS NOT NULL
     AND commerce.catalog_measure_identity(s.measure)=commerce.catalog_measure_identity(NEW.tire_size)
     AND NEW.vehicle_type IS DISTINCT FROM s.vehicle_type) THEN
   RAISE EXCEPTION 'catalog_stock_vehicle_type_conflict';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_stock_vehicle_type_guard BEFORE INSERT OR UPDATE ON commerce.tire_specs
 FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_stock_vehicle_type();

CREATE OR REPLACE VIEW commerce.wholesale_purchase_lines AS
 SELECT i.id,i.environment,i.purchase_id,i.measure,i.brand,i.tire_condition,
   i.quantity,i.ordered_quantity,i.accepted_quantity,i.unit_cost,i.line_total,
   i.allocated_cost,'catalog'::text item_kind,i.vehicle_type FROM commerce.wholesale_purchase_items i
 UNION ALL
 SELECT l.id,l.environment,l.purchase_id,'Lote: '||l.description,NULL::text,NULL::text,
   l.ordered_quantity,l.ordered_quantity,l.accepted_quantity,
   l.products_amount/l.ordered_quantity,l.products_amount,l.allocated_cost,'lot'::text,l.vehicle_type
 FROM commerce.tire_lots l WHERE l.origin_type='purchase';

REVOKE ALL ON FUNCTION commerce.catalog_vehicle_type(env_t,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.stock_vehicle_type(env_t,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.capture_operation_vehicle_type() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.guard_catalog_stock_vehicle_type() FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics.capture_demand_vehicle_type() FROM PUBLIC;
-- Preserve category even when a stock-only variant is removed.
CREATE OR REPLACE FUNCTION commerce.log_wholesale_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = commerce, pg_catalog
AS $fn$
DECLARE
  v_source TEXT := NULLIF(current_setting('app.galpao_source', true), '');
  v_reason TEXT := NULLIF(current_setting('app.galpao_reason', true), '');
  v_ref    TEXT := NULLIF(current_setting('app.galpao_ref', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO commerce.wholesale_stock_movements
      (environment, measure, brand, tire_condition, op, qty_before, qty_after,
       cost_before, cost_after, source, reason, ref, vehicle_type)
    VALUES
      (NEW.environment, NEW.measure, NEW.brand, NEW.tire_condition, 'insert', 0,
       NEW.quantity_on_hand, NULL, NEW.unit_cost, COALESCE(v_source, 'sem_rotulo'),
       v_reason, v_ref, NEW.vehicle_type);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.measure IS DISTINCT FROM OLD.measure
       OR NEW.brand IS DISTINCT FROM OLD.brand
       OR NEW.tire_condition IS DISTINCT FROM OLD.tire_condition
       OR NEW.environment IS DISTINCT FROM OLD.environment THEN
      RAISE EXCEPTION 'wholesale_stock_identity_immutable';
    END IF;
    IF NEW.quantity_on_hand IS DISTINCT FROM OLD.quantity_on_hand
       OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
      INSERT INTO commerce.wholesale_stock_movements
        (environment, measure, brand, tire_condition, op, qty_before, qty_after,
         cost_before, cost_after, source, reason, ref, vehicle_type)
      VALUES
        (NEW.environment, NEW.measure, NEW.brand, NEW.tire_condition, 'update',
         OLD.quantity_on_hand, NEW.quantity_on_hand, OLD.unit_cost, NEW.unit_cost,
         COALESCE(v_source, 'sem_rotulo'), v_reason, v_ref, NEW.vehicle_type);
    END IF;
    RETURN NEW;
  ELSE
    INSERT INTO commerce.wholesale_stock_movements
      (environment, measure, brand, tire_condition, op, qty_before, qty_after,
       cost_before, cost_after, source, reason, ref, vehicle_type)
    VALUES
      (OLD.environment, OLD.measure, OLD.brand, OLD.tire_condition, 'delete',
       OLD.quantity_on_hand, 0, OLD.unit_cost, NULL,
       COALESCE(v_source, 'remocao'), v_reason, v_ref, OLD.vehicle_type);
    RETURN OLD;
  END IF;
END;
$fn$;


ALTER TABLE commerce.wholesale_replenishment_policies ADD COLUMN vehicle_type text CHECK(vehicle_type IN ('motorcycle','car'));
ALTER TABLE commerce.wholesale_replenishment_policies DROP CONSTRAINT wholesale_replenishment_policies_pkey;
ALTER TABLE commerce.wholesale_replenishment_policies ADD CONSTRAINT wholesale_replenishment_policies_vehicle_unique
 UNIQUE NULLS NOT DISTINCT (environment,measure,tire_condition,vehicle_type);
COMMENT ON TABLE commerce.wholesale_replenishment_policies IS
 'Minimum by measure, condition and explicitly recorded vehicle type. Existing unclassified policies are preserved.';
COMMIT;
