-- 0155_wholesale_stock_multi_brand.sql
-- A identidade do saldo passa de (environment, measure) para
-- (environment, measure, brand), preservando todas as linhas atuais.

ALTER TABLE commerce.wholesale_stock ADD COLUMN IF NOT EXISTS brand TEXT;

UPDATE commerce.wholesale_stock ws
   SET brand = COALESCE(NULLIF(btrim(ws.brand), ''), (
     SELECT CASE
              WHEN count(DISTINCT lower(btrim(p.brand)))
                     FILTER (WHERE NULLIF(btrim(p.brand), '') IS NOT NULL) = 1
              THEN min(btrim(p.brand))
                     FILTER (WHERE NULLIF(btrim(p.brand), '') IS NOT NULL)
              ELSE NULL
            END
       FROM commerce.products p
      WHERE p.environment = ws.environment
        AND p.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM commerce.tire_specs ts
           WHERE ts.environment = p.environment
             AND ts.product_id = p.id
             AND ts.tire_size = ws.measure
        )
   ), 'Sem marca')
 WHERE brand IS NULL OR btrim(brand) = '';

ALTER TABLE commerce.wholesale_stock ALTER COLUMN brand SET NOT NULL;
ALTER TABLE commerce.wholesale_stock ALTER COLUMN brand SET DEFAULT 'Sem marca';
ALTER TABLE commerce.wholesale_stock
  DROP CONSTRAINT IF EXISTS wholesale_stock_brand_valid;
ALTER TABLE commerce.wholesale_stock
  ADD CONSTRAINT wholesale_stock_brand_valid
  CHECK (brand = btrim(brand) AND brand <> '');

DROP INDEX IF EXISTS commerce.wholesale_stock_measure_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS wholesale_stock_measure_brand_uniq
  ON commerce.wholesale_stock(environment, measure, brand);

UPDATE commerce.wholesale_order_items i
   SET brand = COALESCE(NULLIF(btrim(i.brand), ''), (
     SELECT CASE WHEN count(*) = 1 THEN min(ws.brand) ELSE NULL END
       FROM commerce.wholesale_stock ws
      WHERE ws.environment=i.environment AND ws.measure=i.measure
   ), 'Sem marca')
 WHERE brand IS NULL OR btrim(brand) = '';

UPDATE commerce.wholesale_purchase_items i
   SET brand = COALESCE(NULLIF(btrim(i.brand), ''), (
     SELECT CASE WHEN count(*) = 1 THEN min(ws.brand) ELSE NULL END
       FROM commerce.wholesale_stock ws
      WHERE ws.environment=i.environment AND ws.measure=i.measure
   ), 'Sem marca')
 WHERE brand IS NULL OR btrim(brand) = '';

ALTER TABLE commerce.wholesale_order_items ALTER COLUMN brand SET NOT NULL;
ALTER TABLE commerce.wholesale_purchase_items ALTER COLUMN brand SET NOT NULL;
ALTER TABLE commerce.wholesale_order_items ALTER COLUMN brand SET DEFAULT 'Sem marca';
ALTER TABLE commerce.wholesale_purchase_items ALTER COLUMN brand SET DEFAULT 'Sem marca';

ALTER TABLE commerce.wholesale_stock_movements ADD COLUMN IF NOT EXISTS brand TEXT;

UPDATE commerce.wholesale_stock_movements m
   SET brand = COALESCE(NULLIF(btrim(m.brand), ''), (
     SELECT CASE WHEN count(*) = 1 THEN min(ws.brand) ELSE NULL END
       FROM commerce.wholesale_stock ws
      WHERE ws.environment = m.environment AND ws.measure = m.measure
   ), (
     SELECT CASE
              WHEN count(DISTINCT lower(btrim(p.brand)))
                     FILTER (WHERE NULLIF(btrim(p.brand), '') IS NOT NULL) = 1
              THEN min(btrim(p.brand))
                     FILTER (WHERE NULLIF(btrim(p.brand), '') IS NOT NULL)
              ELSE NULL
            END
       FROM commerce.products p
      WHERE p.environment = m.environment
        AND p.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM commerce.tire_specs ts
           WHERE ts.environment = p.environment
             AND ts.product_id = p.id
             AND ts.tire_size = m.measure
        )
   ), 'Sem marca')
 WHERE brand IS NULL OR btrim(brand) = '';

ALTER TABLE commerce.wholesale_stock_movements ALTER COLUMN brand SET NOT NULL;
ALTER TABLE commerce.wholesale_stock_movements ALTER COLUMN brand SET DEFAULT 'Sem marca';
ALTER TABLE commerce.wholesale_stock_movements
  DROP CONSTRAINT IF EXISTS wholesale_stock_movements_brand_valid;
ALTER TABLE commerce.wholesale_stock_movements
  ADD CONSTRAINT wholesale_stock_movements_brand_valid
  CHECK (brand = btrim(brand) AND brand <> '');

CREATE INDEX IF NOT EXISTS wholesale_stock_movements_measure_brand_idx
  ON commerce.wholesale_stock_movements(environment, measure, brand, created_at DESC);

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
      (environment, measure, brand, op, qty_before, qty_after, cost_before, cost_after,
       source, reason, ref)
    VALUES
      (NEW.environment, NEW.measure, NEW.brand, 'insert', 0, NEW.quantity_on_hand, NULL,
       NEW.unit_cost, COALESCE(v_source, 'sem_rotulo'), v_reason, v_ref);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.measure IS DISTINCT FROM OLD.measure
       OR NEW.brand IS DISTINCT FROM OLD.brand
       OR NEW.environment IS DISTINCT FROM OLD.environment THEN
      RAISE EXCEPTION 'wholesale_stock_identity_immutable';
    END IF;
    IF NEW.quantity_on_hand IS DISTINCT FROM OLD.quantity_on_hand
       OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
      INSERT INTO commerce.wholesale_stock_movements
        (environment, measure, brand, op, qty_before, qty_after, cost_before, cost_after,
         source, reason, ref)
      VALUES
        (NEW.environment, NEW.measure, NEW.brand, 'update', OLD.quantity_on_hand,
         NEW.quantity_on_hand, OLD.unit_cost, NEW.unit_cost,
         COALESCE(v_source, 'sem_rotulo'), v_reason, v_ref);
    END IF;
    RETURN NEW;
  ELSE
    INSERT INTO commerce.wholesale_stock_movements
      (environment, measure, brand, op, qty_before, qty_after, cost_before, cost_after,
       source, reason, ref)
    VALUES
      (OLD.environment, OLD.measure, OLD.brand, 'delete', OLD.quantity_on_hand, 0,
       OLD.unit_cost, NULL, COALESCE(v_source, 'remocao'), v_reason, v_ref);
    RETURN OLD;
  END IF;
END;
$fn$;

DO $check$
DECLARE v_count INTEGER;
BEGIN
  PERFORM set_config('app.galpao_source', 'smoke_0155', true);
  INSERT INTO commerce.wholesale_stock
    (environment, measure, brand, quantity_on_hand, unit_cost)
  VALUES
    ('test', '0155-SMOKE', 'Marca A', 3, 10),
    ('test', '0155-SMOKE', 'Marca B', 7, 20);

  UPDATE commerce.wholesale_stock SET quantity_on_hand = quantity_on_hand - 1
   WHERE environment='test' AND measure='0155-SMOKE' AND brand='Marca A';

  SELECT count(*) INTO v_count FROM commerce.wholesale_stock
   WHERE environment='test' AND measure='0155-SMOKE';
  IF v_count <> 2 THEN
    RAISE EXCEPTION '0155 falhou: mesma medida nao aceitou duas marcas';
  END IF;
  IF (SELECT quantity_on_hand FROM commerce.wholesale_stock
       WHERE environment='test' AND measure='0155-SMOKE' AND brand='Marca A') <> 2
     OR
     (SELECT quantity_on_hand FROM commerce.wholesale_stock
       WHERE environment='test' AND measure='0155-SMOKE' AND brand='Marca B') <> 7 THEN
    RAISE EXCEPTION '0155 falhou: saldos por marca nao ficaram independentes';
  END IF;

  DELETE FROM commerce.wholesale_stock
   WHERE environment='test' AND measure='0155-SMOKE';
  DELETE FROM commerce.wholesale_stock_movements
   WHERE environment='test' AND measure='0155-SMOKE';

  IF has_table_privilege(
    'farejador_partner_app', 'commerce.wholesale_stock_movements', 'SELECT'
  ) THEN
    RAISE EXCEPTION '0155 falhou: parceiro nao pode ler movimentos do galpao';
  END IF;
END;
$check$;
