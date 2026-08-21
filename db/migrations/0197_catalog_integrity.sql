-- 0197 - Integridade do Catálogo central e do preço local dos parceiros.
--
-- Protege no banco as mesmas regras já exigidas pelas APIs:
--   * preço comercial é positivo;
--   * só existe uma janela aberta por produto e tipo de preço;
--   * janelas do mesmo tipo não se sobrepõem;
--   * uma variante ativa de pneu (medida + marca + condição) é única.

ALTER TABLE commerce.matriz_product_prices
  DROP CONSTRAINT IF EXISTS matriz_product_prices_price_amount_check;
ALTER TABLE commerce.matriz_product_prices
  ADD CONSTRAINT matriz_product_prices_price_amount_check
  CHECK (price_amount > 0) NOT VALID;
ALTER TABLE commerce.matriz_product_prices
  VALIDATE CONSTRAINT matriz_product_prices_price_amount_check;

ALTER TABLE commerce.product_prices
  DROP CONSTRAINT IF EXISTS product_prices_price_amount_check;
ALTER TABLE commerce.product_prices
  ADD CONSTRAINT product_prices_price_amount_check
  CHECK (price_amount > 0) NOT VALID;
ALTER TABLE commerce.product_prices
  VALIDATE CONSTRAINT product_prices_price_amount_check;

ALTER TABLE commerce.partner_stock_levels
  DROP CONSTRAINT IF EXISTS partner_stock_levels_sale_price_check;
ALTER TABLE commerce.partner_stock_levels
  ADD CONSTRAINT partner_stock_levels_sale_price_check
  CHECK (sale_price IS NULL OR sale_price > 0) NOT VALID;
ALTER TABLE commerce.partner_stock_levels
  VALIDATE CONSTRAINT partner_stock_levels_sale_price_check;

CREATE UNIQUE INDEX IF NOT EXISTS matriz_product_prices_one_open_idx
  ON commerce.matriz_product_prices(environment,product_id)
  WHERE valid_until IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_prices_one_open_type_idx
  ON commerce.product_prices(environment,product_id,price_type)
  WHERE valid_until IS NULL;

CREATE OR REPLACE FUNCTION commerce.catalog_brand_identity(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $function$
  SELECT CASE WHEN normalized IN ('','semmarca') THEN '' ELSE normalized END
    FROM (
      SELECT regexp_replace(
        translate(lower(btrim(COALESCE(value,''))),
          'áàâãäéèêëíìîïóòôõöúùûüç',
          'aaaaaeeeeiiiiooooouuuuc'),
        '[^a-z0-9]+','','g') AS normalized
    ) identity_value;
$function$;

CREATE OR REPLACE FUNCTION commerce.catalog_measure_identity(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $function$
  SELECT regexp_replace(COALESCE(value,''),'[^0-9]+','','g');
$function$;

REVOKE ALL ON FUNCTION commerce.catalog_brand_identity(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.catalog_measure_identity(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION commerce.guard_catalog_tire_variant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE
  selected_product_id UUID;
  selected_environment env_t;
  selected_product_type TEXT;
  selected_brand TEXT;
  selected_condition TEXT;
  selected_deleted_at TIMESTAMPTZ;
  selected_measure TEXT;
  identity_key TEXT;
BEGIN
  IF TG_TABLE_NAME='tire_specs' THEN
    selected_product_id := NEW.product_id;
    selected_environment := NEW.environment;
    selected_measure := NEW.tire_size;
    SELECT p.product_type,p.brand,p.tire_condition,p.deleted_at
      INTO selected_product_type,selected_brand,selected_condition,selected_deleted_at
      FROM commerce.products p
     WHERE p.id=NEW.product_id AND p.environment=NEW.environment;
  ELSE
    selected_product_id := NEW.id;
    selected_environment := NEW.environment;
    selected_product_type := NEW.product_type;
    selected_brand := NEW.brand;
    selected_condition := NEW.tire_condition;
    selected_deleted_at := NEW.deleted_at;
    SELECT ts.tire_size INTO selected_measure
      FROM commerce.tire_specs ts
     WHERE ts.environment=NEW.environment AND ts.product_id=NEW.id;
  END IF;

  IF selected_product_type IS DISTINCT FROM 'tire'
     OR selected_deleted_at IS NOT NULL OR selected_measure IS NULL THEN
    RETURN NEW;
  END IF;

  identity_key := selected_environment::text || ':'
    || commerce.catalog_measure_identity(selected_measure) || ':'
    || commerce.catalog_brand_identity(selected_brand) || ':'
    || COALESCE(selected_condition,'');
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-variant:' || identity_key,0));

  IF EXISTS (
    SELECT 1
      FROM commerce.products p
      JOIN commerce.tire_specs ts
        ON ts.environment=p.environment AND ts.product_id=p.id
     WHERE p.environment=selected_environment
       AND p.id<>selected_product_id
       AND p.product_type='tire'
       AND p.deleted_at IS NULL
       AND commerce.catalog_measure_identity(ts.tire_size)
           =commerce.catalog_measure_identity(selected_measure)
       AND commerce.catalog_brand_identity(p.brand)
           =commerce.catalog_brand_identity(selected_brand)
       AND p.tire_condition IS NOT DISTINCT FROM selected_condition
  ) THEN
    RAISE EXCEPTION 'catalog_variant_duplicate' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION commerce.guard_catalog_tire_variant() FROM PUBLIC;

DROP TRIGGER IF EXISTS catalog_tire_variant_from_spec ON commerce.tire_specs;
CREATE TRIGGER catalog_tire_variant_from_spec
BEFORE INSERT OR UPDATE OF environment,product_id,tire_size
ON commerce.tire_specs
FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_tire_variant();

DROP TRIGGER IF EXISTS catalog_tire_variant_from_product ON commerce.products;
CREATE TRIGGER catalog_tire_variant_from_product
BEFORE UPDATE OF environment,product_type,brand,tire_condition,deleted_at
ON commerce.products
FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_tire_variant();

CREATE OR REPLACE FUNCTION commerce.guard_catalog_price_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE
  selected_type TEXT := 'matriz';
  identity_key TEXT;
  has_overlap BOOLEAN;
BEGIN
  IF TG_TABLE_NAME='product_prices' THEN
    selected_type := NEW.price_type;
  END IF;
  identity_key := NEW.environment::text || ':' || NEW.product_id::text || ':' || selected_type;
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-price-window:' || identity_key,0));

  IF TG_TABLE_NAME='product_prices' THEN
    SELECT EXISTS (
      SELECT 1 FROM commerce.product_prices current_price
       WHERE current_price.environment=NEW.environment
         AND current_price.product_id=NEW.product_id
         AND current_price.price_type=NEW.price_type
         AND current_price.id<>NEW.id
         AND tstzrange(current_price.valid_from,
               COALESCE(current_price.valid_until,'infinity'::timestamptz),'[)')
             && tstzrange(NEW.valid_from,
               COALESCE(NEW.valid_until,'infinity'::timestamptz),'[)')
    ) INTO has_overlap;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM commerce.matriz_product_prices current_price
       WHERE current_price.environment=NEW.environment
         AND current_price.product_id=NEW.product_id
         AND current_price.id<>NEW.id
         AND tstzrange(current_price.valid_from,
               COALESCE(current_price.valid_until,'infinity'::timestamptz),'[)')
             && tstzrange(NEW.valid_from,
               COALESCE(NEW.valid_until,'infinity'::timestamptz),'[)')
    ) INTO has_overlap;
  END IF;

  IF has_overlap THEN
    RAISE EXCEPTION 'catalog_price_window_overlap' USING ERRCODE='23P01';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION commerce.guard_catalog_price_window() FROM PUBLIC;

DROP TRIGGER IF EXISTS matriz_product_price_window_guard
  ON commerce.matriz_product_prices;
CREATE TRIGGER matriz_product_price_window_guard
BEFORE INSERT OR UPDATE OF environment,product_id,valid_from,valid_until
ON commerce.matriz_product_prices
FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_price_window();

DROP TRIGGER IF EXISTS product_price_window_guard ON commerce.product_prices;
CREATE TRIGGER product_price_window_guard
BEFORE INSERT OR UPDATE OF environment,product_id,price_type,valid_from,valid_until
ON commerce.product_prices
FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_price_window();

CREATE OR REPLACE FUNCTION commerce.guard_catalog_price_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE
  row_environment env_t := OLD.environment;
BEGIN
  -- Fixtures de integração continuam descartáveis. Em produção, preço publicado
  -- é um snapshot: encerra-se a validade e cria-se uma nova linha.
  IF row_environment<>'prod' THEN
    IF TG_OP='DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'catalog_price_history_immutable' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-'valid_until') IS DISTINCT FROM
     (to_jsonb(OLD)-'valid_until') THEN
    RAISE EXCEPTION 'catalog_price_history_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.valid_until IS NOT DISTINCT FROM OLD.valid_until THEN
    RETURN NEW;
  END IF;
  IF OLD.valid_until IS NOT NULL OR NEW.valid_until IS NULL THEN
    RAISE EXCEPTION 'catalog_price_history_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION commerce.guard_catalog_price_history() FROM PUBLIC;

DROP TRIGGER IF EXISTS matriz_product_price_immutable_update
  ON commerce.matriz_product_prices;
CREATE TRIGGER matriz_product_price_immutable_update
BEFORE UPDATE
ON commerce.matriz_product_prices
FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_price_history();

DROP TRIGGER IF EXISTS matriz_product_price_immutable_delete
  ON commerce.matriz_product_prices;
CREATE TRIGGER matriz_product_price_immutable_delete
BEFORE DELETE ON commerce.matriz_product_prices
FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_price_history();

DROP TRIGGER IF EXISTS product_price_immutable_update ON commerce.product_prices;
CREATE TRIGGER product_price_immutable_update
BEFORE UPDATE
ON commerce.product_prices
FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_price_history();

DROP TRIGGER IF EXISTS product_price_immutable_delete ON commerce.product_prices;
CREATE TRIGGER product_price_immutable_delete
BEFORE DELETE ON commerce.product_prices
FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_price_history();

DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM commerce.matriz_product_prices WHERE price_amount<=0)
     OR EXISTS (SELECT 1 FROM commerce.product_prices WHERE price_amount<=0)
     OR EXISTS (SELECT 1 FROM commerce.partner_stock_levels
                 WHERE sale_price IS NOT NULL AND sale_price<=0) THEN
    RAISE EXCEPTION '0197 falhou: preço comercial não positivo';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname='catalog_tire_variant_from_spec' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname='matriz_product_price_window_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname='matriz_product_price_immutable_delete' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0197 falhou: guardas do Catálogo ausentes';
  END IF;
END;
$check$;
