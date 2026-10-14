-- Usados sem marca são uma identidade exclusiva do parceiro.
-- Não consolida saldos/preços existentes nem muda compras, reservas ou pedidos.
BEGIN;
ALTER TABLE commerce.products ADD COLUMN partner_generic boolean NOT NULL DEFAULT false;
ALTER TABLE commerce.products ADD CONSTRAINT partner_generic_used_only CHECK (
  NOT partner_generic OR (product_type='tire' AND tire_condition='meia_vida' AND brand IS NULL)
);
COMMENT ON COLUMN commerce.products.partner_generic IS
  'Identidade de usado sem marca para estoque do parceiro. Nunca é SKU de venda/estoque da Matriz.';

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
  selected_partner_generic BOOLEAN;
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
    SELECT p.product_type,p.brand,p.tire_condition,p.deleted_at,p.partner_generic
      INTO selected_product_type,selected_brand,selected_condition,selected_deleted_at,selected_partner_generic
      FROM commerce.products p
     WHERE p.id=NEW.product_id AND p.environment=NEW.environment;
  ELSE
    selected_product_id := NEW.id;
    selected_environment := NEW.environment;
    selected_product_type := NEW.product_type;
    selected_partner_generic := NEW.partner_generic;
    selected_brand := NEW.brand;
    selected_condition := NEW.tire_condition;
    selected_deleted_at := NEW.deleted_at;
    SELECT ts.tire_size INTO selected_measure
      FROM commerce.tire_specs ts
     WHERE ts.environment=NEW.environment AND ts.product_id=NEW.id;
  END IF;

  IF selected_partner_generic OR selected_product_type IS DISTINCT FROM 'tire'
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
       AND p.product_type='tire' AND NOT p.partner_generic
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


CREATE OR REPLACE FUNCTION commerce.validate_tire_catalog_variant()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_product commerce.products%ROWTYPE;
BEGIN
  SELECT * INTO v_product
    FROM commerce.products
   WHERE id=NEW.product_id AND environment=NEW.environment;
  IF NOT v_product.partner_generic AND v_product.product_type='tire' AND EXISTS (
    SELECT 1
      FROM commerce.tire_specs other_spec
      JOIN commerce.products other_product
        ON other_product.id=other_spec.product_id
       AND other_product.environment=other_spec.environment
     WHERE other_spec.environment=NEW.environment
       AND other_spec.id<>COALESCE(NEW.id,gen_random_uuid())
       AND other_product.deleted_at IS NULL AND NOT other_product.partner_generic
       AND lower(btrim(COALESCE(other_product.brand,'')))
           =lower(btrim(COALESCE(v_product.brand,'')))
       AND other_product.tire_condition=v_product.tire_condition
       AND regexp_replace(other_spec.tire_size,'[^0-9]+','','g')
           =regexp_replace(NEW.tire_size,'[^0-9]+','','g')
  ) THEN
    RAISE EXCEPTION 'catalog_variant_already_exists';
  END IF;
  RETURN NEW;
END;
$fn$;


CREATE OR REPLACE FUNCTION commerce.catalog_vehicle_type(e env_t,m text,b text,c text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN count(*)>0 AND count(*)=count(ts.vehicle_type)
   AND count(DISTINCT ts.vehicle_type)=1 THEN min(ts.vehicle_type) END
 FROM commerce.tire_specs ts JOIN commerce.products p ON p.environment=ts.environment AND p.id=ts.product_id
 WHERE NOT p.partner_generic AND p.environment=e AND p.deleted_at IS NULL AND p.product_type='tire'
   AND commerce.catalog_measure_identity(ts.tire_size)=commerce.catalog_measure_identity(m)
   AND (b IS NULL OR commerce.catalog_brand_identity(p.brand)=commerce.catalog_brand_identity(b))
   AND (c IS NULL OR p.tire_condition=c)
$$;

CREATE OR REPLACE FUNCTION commerce.guard_catalog_stock_vehicle_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM commerce.products p JOIN commerce.wholesale_stock s
   ON s.environment=p.environment AND commerce.catalog_brand_identity(s.brand)=commerce.catalog_brand_identity(p.brand)
     AND s.tire_condition=p.tire_condition
   WHERE NOT p.partner_generic AND p.environment=NEW.environment AND p.id=NEW.product_id AND s.vehicle_type IS NOT NULL
     AND commerce.catalog_measure_identity(s.measure)=commerce.catalog_measure_identity(NEW.tire_size)
     AND NEW.vehicle_type IS DISTINCT FROM s.vehicle_type) THEN
   RAISE EXCEPTION 'catalog_stock_vehicle_type_conflict';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE VIEW commerce.product_full AS
SELECT
  p.id AS product_id,
  p.environment,
  p.product_code,
  p.product_name,
  p.product_type,
  p.brand,
  p.short_description,
  ts.tire_size,
  ts.width_mm,
  ts.aspect_ratio,
  ts.rim_diameter,
  ts.position AS tire_position,
  ts.intended_use,
  cp.price_amount,
  cp.currency,
  cp.price_type,
  COALESCE(SUM(sl.quantity_available), 0) AS total_stock_available,
  p.created_at,
  p.updated_at,
  p.tire_condition
FROM commerce.products p
LEFT JOIN commerce.tire_specs ts
  ON ts.product_id = p.id AND ts.environment = p.environment
LEFT JOIN commerce.current_prices cp
  ON cp.product_id = p.id AND cp.environment = p.environment
LEFT JOIN commerce.stock_levels sl
  ON sl.product_id = p.id AND sl.environment = p.environment
WHERE p.deleted_at IS NULL AND NOT p.partner_generic
GROUP BY p.id, ts.tire_size, ts.width_mm, ts.aspect_ratio, ts.rim_diameter,
         ts.position, ts.intended_use, cp.price_amount, cp.currency, cp.price_type;


CREATE OR REPLACE FUNCTION commerce.partner_wholesale_catalog()
RETURNS TABLE (offer_key uuid,measure text,brand text,tire_condition text,
  vehicle_type text,quantity_available integer,price_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
WITH unit AS (
  SELECT pu.environment FROM network.partner_units pu
  JOIN network.partners p ON p.id=pu.partner_id AND p.environment=pu.environment
  WHERE pu.id=network.current_partner_unit() AND pu.status='active' AND p.status='active'
), variants AS (
  SELECT p.id,p.environment,ts.tire_size,p.brand,p.tire_condition,ts.vehicle_type,
    commerce.catalog_measure_identity(ts.tire_size) AS measure_key,
    commerce.catalog_brand_identity(p.brand) AS brand_key,
    count(*) OVER (PARTITION BY p.environment,commerce.catalog_measure_identity(ts.tire_size),
      commerce.catalog_brand_identity(p.brand),p.tire_condition) AS variant_count
  FROM commerce.products p JOIN unit u ON u.environment=p.environment
  JOIN commerce.tire_specs ts ON ts.environment=p.environment AND ts.product_id=p.id
  WHERE NOT p.partner_generic AND p.product_type='tire' AND p.deleted_at IS NULL
)
SELECT v.id,v.tire_size,v.brand,v.tire_condition,
  COALESCE(v.vehicle_type,w.vehicle_type),w.available, (wp.price_amount*100)::bigint
FROM variants v
JOIN commerce.wholesale_current_prices wp ON wp.environment=v.environment AND wp.product_id=v.id
JOIN LATERAL (
  -- Duplicatas normalizadas são ambíguas; não somar nem anunciar o mesmo saldo duas vezes.
  SELECT min(s.quantity_on_hand-s.quantity_reserved)::integer AS available,
    min(s.vehicle_type) AS vehicle_type
  FROM commerce.wholesale_stock s
  WHERE s.environment=v.environment
    AND commerce.catalog_measure_identity(s.measure)=v.measure_key
    AND commerce.catalog_brand_identity(s.brand)=v.brand_key AND s.tire_condition=v.tire_condition
  HAVING count(*)=1
) w ON w.available>0
WHERE v.variant_count=1 AND NULLIF(v.measure_key,'') IS NOT NULL
  AND COALESCE(v.vehicle_type,w.vehicle_type) IN ('motorcycle','car')
  AND (v.vehicle_type IS NULL OR w.vehicle_type IS NULL OR v.vehicle_type=w.vehicle_type)
ORDER BY v.tire_size,v.tire_condition,v.brand,v.id;
$$;

-- O parceiro não ganha INSERT/UPDATE no catálogo. Só pode obter uma identidade
-- determinística de usado, no próprio ambiente, sem preço/custo/saldo central.
CREATE FUNCTION commerce.ensure_partner_used_product(p_measure text,p_vehicle_type text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.env_t; result_id uuid; code text; parts text[]; w integer; a integer; r integer;
BEGIN
  SELECT pu.environment INTO e FROM network.partner_units pu
    JOIN network.partners p ON p.id=pu.partner_id AND p.environment=pu.environment
    WHERE pu.id=network.current_partner_unit() AND pu.status='active' AND p.status='active'
      AND pu.deleted_at IS NULL AND p.deleted_at IS NULL;
  IF e IS NULL THEN RAISE EXCEPTION 'partner_context_required' USING ERRCODE='42501'; END IF;
  parts:=regexp_match(p_measure,'^([0-9]{2,3})/([0-9]{2,3})-([0-9]{2})$');
  IF parts IS NULL OR p_vehicle_type IS NULL OR p_vehicle_type NOT IN ('motorcycle','car') THEN
    RAISE EXCEPTION 'invalid_partner_used_identity' USING ERRCODE='22023';
  END IF;
  w:=parts[1]::integer; a:=parts[2]::integer; r:=parts[3]::integer;
  IF w NOT BETWEEN 50 AND 400 OR a NOT BETWEEN 20 AND 100 OR r NOT BETWEEN 8 AND 30 THEN
    RAISE EXCEPTION 'invalid_partner_used_identity' USING ERRCODE='22023';
  END IF;
  code:='PARTNER-USED:'||p_vehicle_type||':'||w||'/'||a||'-'||r;
  PERFORM pg_advisory_xact_lock(hashtextextended(e::text||':'||code,0));
  SELECT id INTO result_id FROM commerce.products WHERE environment=e AND product_code=code
    AND partner_generic AND deleted_at IS NULL;
  IF result_id IS NOT NULL THEN RETURN result_id; END IF;
  INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition,partner_generic)
    VALUES(e,code,'Pneu usado '||w||'/'||a||'-'||r,'tire',NULL,'meia_vida',true) RETURNING id INTO result_id;
  INSERT INTO commerce.tire_specs(environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter,vehicle_type)
    VALUES(e,result_id,w||'/'||a||'-'||r,w,a,r,p_vehicle_type);
  INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
    VALUES(e,'catalog','commerce.products',result_id,'partner_used_identity_created','partner_stock',
      jsonb_build_object('tire_size',p_measure,'vehicle_type',p_vehicle_type,'partner_unit_id',network.current_partner_unit()));
  RETURN result_id;
END $$;
REVOKE ALL ON FUNCTION commerce.ensure_partner_used_product(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.ensure_partner_used_product(text,text) TO farejador_partner_app;

-- Falha fechada mesmo se um endpoint central receber o UUID de um usado do parceiro.
CREATE FUNCTION commerce.guard_partner_used_central_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM commerce.products p WHERE p.id=NEW.product_id
    AND p.environment=NEW.environment AND p.partner_generic) THEN
    RAISE EXCEPTION 'partner_used_not_matriz_product' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION commerce.guard_partner_used_central_write() FROM PUBLIC;
CREATE TRIGGER partner_used_no_matriz_price BEFORE INSERT OR UPDATE ON commerce.matriz_product_prices
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_partner_used_central_write();
CREATE TRIGGER partner_used_no_wholesale_price BEFORE INSERT OR UPDATE ON commerce.wholesale_product_prices
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_partner_used_central_write();
CREATE TRIGGER partner_used_no_central_price BEFORE INSERT OR UPDATE ON commerce.product_prices
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_partner_used_central_write();
CREATE TRIGGER partner_used_no_central_stock BEFORE INSERT OR UPDATE ON commerce.stock_levels
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_partner_used_central_write();
COMMIT;
