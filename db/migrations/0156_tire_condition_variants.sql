-- 0156_tire_condition_variants.sql
-- Condicao do pneu como parte da identidade comercial e de estoque.
-- Identidade da matriz: (environment, measure, brand, tire_condition).
-- Valores canonicos: meia_vida, novo, remold.

-- Catalogo: os pneus atuais da matriz representam a operacao historica de meia-vida.
ALTER TABLE commerce.products
  ADD COLUMN IF NOT EXISTS tire_condition TEXT;

UPDATE commerce.products
   SET tire_condition = 'meia_vida'
 WHERE product_type = 'tire'
   AND tire_condition IS NULL;

ALTER TABLE commerce.products
  DROP CONSTRAINT IF EXISTS products_tire_condition_check;
ALTER TABLE commerce.products
  ADD CONSTRAINT products_tire_condition_check CHECK (
    (product_type = 'tire' AND tire_condition IN ('meia_vida', 'novo', 'remold'))
    OR (product_type <> 'tire' AND tire_condition IS NULL)
  );

COMMENT ON COLUMN commerce.products.tire_condition IS
  'Condicao comercial da variante de pneu: meia_vida, novo ou remold. NULL apenas para itens que nao sao pneus.';

-- Mantem a ordem antiga da view e acrescenta a condicao no final para nao quebrar
-- consumidores posicionais legados.
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
WHERE p.deleted_at IS NULL
GROUP BY p.id, ts.tire_size, ts.width_mm, ts.aspect_ratio, ts.rim_diameter,
         ts.position, ts.intended_use, cp.price_amount, cp.currency, cp.price_type;

-- Estoque, compras, movimentos e atacado da matriz.
ALTER TABLE commerce.wholesale_stock
  ADD COLUMN IF NOT EXISTS tire_condition TEXT;
UPDATE commerce.wholesale_stock
   SET tire_condition = 'meia_vida'
 WHERE tire_condition IS NULL;
ALTER TABLE commerce.wholesale_stock
  ALTER COLUMN tire_condition SET DEFAULT 'meia_vida';
ALTER TABLE commerce.wholesale_stock
  ALTER COLUMN tire_condition SET NOT NULL;
ALTER TABLE commerce.wholesale_stock
  DROP CONSTRAINT IF EXISTS wholesale_stock_tire_condition_check;
ALTER TABLE commerce.wholesale_stock
  ADD CONSTRAINT wholesale_stock_tire_condition_check
  CHECK (tire_condition IN ('meia_vida', 'novo', 'remold'));

DROP INDEX IF EXISTS commerce.wholesale_stock_measure_brand_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS wholesale_stock_variant_uniq
  ON commerce.wholesale_stock(environment, measure, brand, tire_condition);

ALTER TABLE commerce.wholesale_purchase_items
  ADD COLUMN IF NOT EXISTS tire_condition TEXT;
UPDATE commerce.wholesale_purchase_items
   SET tire_condition = 'meia_vida'
 WHERE tire_condition IS NULL;
ALTER TABLE commerce.wholesale_purchase_items
  ALTER COLUMN tire_condition SET DEFAULT 'meia_vida';
ALTER TABLE commerce.wholesale_purchase_items
  ALTER COLUMN tire_condition SET NOT NULL;
ALTER TABLE commerce.wholesale_purchase_items
  DROP CONSTRAINT IF EXISTS wholesale_purchase_items_tire_condition_check;
ALTER TABLE commerce.wholesale_purchase_items
  ADD CONSTRAINT wholesale_purchase_items_tire_condition_check
  CHECK (tire_condition IN ('meia_vida', 'novo', 'remold'));

ALTER TABLE commerce.wholesale_order_items
  ADD COLUMN IF NOT EXISTS tire_condition TEXT;
UPDATE commerce.wholesale_order_items
   SET tire_condition = 'meia_vida'
 WHERE tire_condition IS NULL;
ALTER TABLE commerce.wholesale_order_items
  ALTER COLUMN tire_condition SET DEFAULT 'meia_vida';
ALTER TABLE commerce.wholesale_order_items
  ALTER COLUMN tire_condition SET NOT NULL;
ALTER TABLE commerce.wholesale_order_items
  DROP CONSTRAINT IF EXISTS wholesale_order_items_tire_condition_check;
ALTER TABLE commerce.wholesale_order_items
  ADD CONSTRAINT wholesale_order_items_tire_condition_check
  CHECK (tire_condition IN ('meia_vida', 'novo', 'remold'));

ALTER TABLE commerce.wholesale_stock_movements
  ADD COLUMN IF NOT EXISTS tire_condition TEXT;
UPDATE commerce.wholesale_stock_movements
   SET tire_condition = 'meia_vida'
 WHERE tire_condition IS NULL;
ALTER TABLE commerce.wholesale_stock_movements
  ALTER COLUMN tire_condition SET DEFAULT 'meia_vida';
ALTER TABLE commerce.wholesale_stock_movements
  ALTER COLUMN tire_condition SET NOT NULL;
ALTER TABLE commerce.wholesale_stock_movements
  DROP CONSTRAINT IF EXISTS wholesale_stock_movements_tire_condition_check;
ALTER TABLE commerce.wholesale_stock_movements
  ADD CONSTRAINT wholesale_stock_movements_tire_condition_check
  CHECK (tire_condition IN ('meia_vida', 'novo', 'remold'));

DROP INDEX IF EXISTS commerce.wholesale_stock_movements_measure_brand_idx;
CREATE INDEX IF NOT EXISTS wholesale_stock_movements_variant_idx
  ON commerce.wholesale_stock_movements(
    environment, measure, brand, tire_condition, created_at DESC
  );

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
       cost_before, cost_after, source, reason, ref)
    VALUES
      (NEW.environment, NEW.measure, NEW.brand, NEW.tire_condition, 'insert', 0,
       NEW.quantity_on_hand, NULL, NEW.unit_cost, COALESCE(v_source, 'sem_rotulo'),
       v_reason, v_ref);
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
         cost_before, cost_after, source, reason, ref)
      VALUES
        (NEW.environment, NEW.measure, NEW.brand, NEW.tire_condition, 'update',
         OLD.quantity_on_hand, NEW.quantity_on_hand, OLD.unit_cost, NEW.unit_cost,
         COALESCE(v_source, 'sem_rotulo'), v_reason, v_ref);
    END IF;
    RETURN NEW;
  ELSE
    INSERT INTO commerce.wholesale_stock_movements
      (environment, measure, brand, tire_condition, op, qty_before, qty_after,
       cost_before, cost_after, source, reason, ref)
    VALUES
      (OLD.environment, OLD.measure, OLD.brand, OLD.tire_condition, 'delete',
       OLD.quantity_on_hand, 0, OLD.unit_cost, NULL,
       COALESCE(v_source, 'remocao'), v_reason, v_ref);
    RETURN OLD;
  END IF;
END;
$fn$;

-- Historico do varejo: snapshot da condicao no momento do pedido.
ALTER TABLE commerce.order_items
  ADD COLUMN IF NOT EXISTS tire_condition TEXT;
UPDATE commerce.order_items oi
   SET tire_condition = p.tire_condition
  FROM commerce.products p
 WHERE p.id = oi.product_id
   AND p.environment = oi.environment
   AND oi.tire_condition IS NULL;
ALTER TABLE commerce.order_items
  DROP CONSTRAINT IF EXISTS order_items_tire_condition_check;
ALTER TABLE commerce.order_items
  ADD CONSTRAINT order_items_tire_condition_check CHECK (
    tire_condition IS NULL OR tire_condition IN ('meia_vida', 'novo', 'remold')
  );

CREATE OR REPLACE FUNCTION commerce.snapshot_order_item_tire_condition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = commerce, pg_catalog
AS $fn$
BEGIN
  SELECT p.tire_condition
    INTO NEW.tire_condition
    FROM commerce.products p
   WHERE p.id = NEW.product_id
     AND p.environment = NEW.environment;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS order_item_tire_condition_snapshot ON commerce.order_items;
CREATE TRIGGER order_item_tire_condition_snapshot
  BEFORE INSERT OR UPDATE OF product_id ON commerce.order_items
  FOR EACH ROW EXECUTE FUNCTION commerce.snapshot_order_item_tire_condition();

-- Parceiros: converte apenas valores conhecidos. NULL continua NULL para revisao humana.
UPDATE commerce.partner_stock_levels
   SET tire_condition = CASE
     WHEN lower(btrim(tire_condition)) IN ('usado', 'meia vida', 'meia_vida')
       THEN 'meia_vida'
     WHEN lower(btrim(tire_condition)) = 'novo' THEN 'novo'
     WHEN lower(btrim(tire_condition)) IN ('recapado', 'remold', 'remoldado')
       THEN 'remold'
     ELSE NULL
   END
 WHERE tire_condition IS NOT NULL;

ALTER TABLE commerce.partner_stock_levels
  DROP CONSTRAINT IF EXISTS partner_stock_levels_tire_condition_check;
ALTER TABLE commerce.partner_stock_levels
  ADD CONSTRAINT partner_stock_levels_tire_condition_check CHECK (
    tire_condition IS NULL OR tire_condition IN ('meia_vida', 'novo', 'remold')
  );

-- Um vinculo legado discordante faria o bot anunciar a condicao do produto,
-- nao a condicao real informada pelo parceiro. Desvincula e deixa o item para
-- relacao manual com a variante correta, sem apagar estoque nem historico.
INSERT INTO audit.events (
  environment, domain, entity_table, entity_id, event_type, actor_label, payload_after
)
SELECT
  psl.environment, 'stock', 'commerce.partner_stock_levels', psl.id,
  'partner_stock_catalog_condition_unlinked', 'migration:0156',
  jsonb_build_object(
    'product_id', psl.product_id,
    'stock_tire_condition', psl.tire_condition,
    'catalog_tire_condition', p.tire_condition,
    'reason', 'legacy_condition_conflict'
  )
FROM commerce.partner_stock_levels psl
JOIN commerce.products p
  ON p.id=psl.product_id AND p.environment=psl.environment
WHERE COALESCE(psl.item_type,'pneu')='pneu'
  AND psl.tire_condition IS NOT NULL
  AND p.tire_condition IS DISTINCT FROM psl.tire_condition;

UPDATE commerce.partner_stock_levels psl
   SET product_id=NULL,
       updated_by='migration:0156'
  FROM commerce.products p
 WHERE p.id=psl.product_id
   AND p.environment=psl.environment
   AND COALESCE(psl.item_type,'pneu')='pneu'
   AND psl.tire_condition IS NOT NULL
   AND p.tire_condition IS DISTINCT FROM psl.tire_condition;

DROP INDEX IF EXISTS commerce.partner_stock_natural_key_uniq;
CREATE UNIQUE INDEX partner_stock_natural_key_uniq
  ON commerce.partner_stock_levels (
    environment,
    unit_id,
    lower(trim(item_name)),
    COALESCE(lower(trim(tire_size)), ''),
    COALESCE(lower(trim(brand)), ''),
    COALESCE(lower(trim(supplier_name)), ''),
    COALESCE(tire_condition, '')
  )
  WHERE deleted_at IS NULL;

ALTER TABLE commerce.partner_order_items
  ADD COLUMN IF NOT EXISTS tire_condition TEXT;

ALTER TABLE commerce.partner_purchase_items
  ADD COLUMN IF NOT EXISTS tire_condition TEXT;

ALTER TABLE commerce.partner_purchase_items
  DROP CONSTRAINT IF EXISTS partner_purchase_items_tire_condition_check;
ALTER TABLE commerce.partner_purchase_items
  ADD CONSTRAINT partner_purchase_items_tire_condition_check
  CHECK (tire_condition IS NULL OR tire_condition IN ('meia_vida', 'novo', 'remold'));

COMMENT ON COLUMN commerce.partner_purchase_items.tire_condition IS
  'Snapshot da condição informado em compras novas. NULL identifica histórico anterior que exige revisão; nunca é inferido.';
UPDATE commerce.partner_order_items poi
   SET tire_condition = psl.tire_condition
  FROM commerce.partner_stock_levels psl
 WHERE psl.id = poi.partner_stock_id
   AND psl.environment = poi.environment
   AND poi.tire_condition IS NULL;
ALTER TABLE commerce.partner_order_items
  DROP CONSTRAINT IF EXISTS partner_order_items_tire_condition_check;
ALTER TABLE commerce.partner_order_items
  ADD CONSTRAINT partner_order_items_tire_condition_check CHECK (
    tire_condition IS NULL OR tire_condition IN ('meia_vida', 'novo', 'remold')
  );

CREATE OR REPLACE FUNCTION commerce.snapshot_partner_item_tire_condition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = commerce, pg_catalog
AS $fn$
DECLARE
  v_item_type TEXT;
BEGIN
  IF NEW.partner_stock_id IS NOT NULL THEN
    SELECT psl.tire_condition, COALESCE(psl.item_type,'pneu')
      INTO NEW.tire_condition, v_item_type
      FROM commerce.partner_stock_levels psl
     WHERE psl.id = NEW.partner_stock_id
       AND psl.environment = NEW.environment;
    IF v_item_type='pneu' AND NEW.tire_condition IS NULL THEN
      RAISE EXCEPTION 'partner_stock_condition_review_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS partner_order_item_tire_condition_snapshot
  ON commerce.partner_order_items;
CREATE TRIGGER partner_order_item_tire_condition_snapshot
  BEFORE INSERT OR UPDATE OF partner_stock_id ON commerce.partner_order_items
  FOR EACH ROW EXECUTE FUNCTION commerce.snapshot_partner_item_tire_condition();

-- As views de histórico precisam expor o snapshot, não a condição atual do
-- produto/estoque. Assim arquivamento e correções futuras não reescrevem vendas.
CREATE OR REPLACE VIEW dashboard.pedidos_recentes AS
SELECT o.environment,
    o.id AS order_id,
    o.created_at,
    o.unit_id,
    u.slug AS unit_slug,
    u.name AS unit_name,
    o.contact_id,
    o.customer_id,
    COALESCE(ct.name, cu.name, 'Cliente'::text) AS contact_name,
    COALESCE(ct.phone_e164, cu.phone_e164) AS contact_phone,
    o.source,
    o.status,
    o.payment_method,
    o.fulfillment_mode,
    o.delivery_address,
    o.total_amount,
    o.closed_by AS registered_by,
    o.closed_at AS registered_at,
    o.promoted_from_draft_id,
    (SELECT jsonb_agg(jsonb_build_object(
       'product_id',oi.product_id,
       'product_name',p.product_name,
       'product_code',p.product_code,
       'tire_size',ts.tire_size,
       'brand',p.brand,
       'tire_condition',oi.tire_condition,
       'quantity',oi.quantity,
       'unit_price',oi.unit_price,
       'discount_amount',oi.discount_amount,
       'subtotal',oi.quantity::numeric*oi.unit_price-oi.discount_amount
     ) ORDER BY oi.created_at)
       FROM commerce.order_items oi
       LEFT JOIN commerce.products p
         ON p.id=oi.product_id AND p.environment=oi.environment
       LEFT JOIN commerce.tire_specs ts
         ON ts.product_id=oi.product_id AND ts.environment=oi.environment
      WHERE oi.order_id=o.id AND oi.environment=o.environment) AS items,
    (o.partner_order_id IS NOT NULL) AS is_partner,
    po.status::text AS partner_status,
    po.delivery_status::text AS delivery_status,
    CASE WHEN o.partner_order_id IS NOT NULL
         THEN CASE WHEN po.status='paid' THEN 'pago' ELSE 'a_receber' END
         ELSE NULL END AS payment_status
FROM commerce.orders o
LEFT JOIN core.units u ON u.id=o.unit_id
LEFT JOIN core.contacts ct ON ct.id=o.contact_id AND ct.environment=o.environment
LEFT JOIN commerce.customers cu ON cu.id=o.customer_id AND cu.environment=o.environment
LEFT JOIN commerce.partner_orders po
  ON po.id=o.partner_order_id AND po.environment=o.environment;

CREATE OR REPLACE VIEW commerce.partner_orders_full
WITH (security_invoker = true) AS
SELECT
  po.id AS order_id,
  po.environment,
  po.unit_id,
  po.customer_name AS contact_name,
  po.customer_phone AS contact_phone,
  po.total_amount,
  po.status,
  po.payment_method,
  po.fulfillment_mode,
  po.delivery_address,
  po.source_tag,
  po.closed_by AS registered_by,
  po.closed_at,
  po.created_at,
  po.updated_at,
  COALESCE(jsonb_agg(jsonb_build_object(
    'item_name',poi.item_name,
    'tire_size',poi.tire_size,
    'brand',poi.brand,
    'tire_condition',poi.tire_condition,
    'quantity',poi.quantity,
    'unit_price',poi.unit_price,
    'discount_amount',poi.discount_amount,
    'partner_stock_id',poi.partner_stock_id,
    'unit_cost_snapshot',poi.unit_cost_snapshot,
    'cost_status',poi.cost_status
  ) ORDER BY poi.created_at) FILTER (WHERE poi.id IS NOT NULL),'[]'::jsonb) AS items,
  po.notes,
  po.received_amount,
  po.customer_cpf,
  po.customer_id,
  po.delivery_status,
  po.delivery_courier,
  po.dispatched_at,
  po.delivered_at,
  po.awaiting_pickup,
  po.retrieved_at
FROM commerce.partner_orders po
LEFT JOIN commerce.partner_order_items poi
  ON poi.order_id=po.id AND poi.environment=po.environment
WHERE po.deleted_at IS NULL
GROUP BY po.id;

GRANT SELECT ON commerce.partner_orders_full TO farejador_partner_app;

-- A condicao define uma variante. Corrigir significa transferir saldo, nunca renomear
-- silenciosamente uma variante que ja pode ter historico.
CREATE OR REPLACE FUNCTION commerce.enforce_product_tire_condition_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tire_condition IS DISTINCT FROM OLD.tire_condition THEN
    RAISE EXCEPTION 'product_tire_condition_immutable';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS products_tire_condition_immutable ON commerce.products;
CREATE TRIGGER products_tire_condition_immutable
  BEFORE UPDATE OF tire_condition ON commerce.products
  FOR EACH ROW EXECUTE FUNCTION commerce.enforce_product_tire_condition_immutable();

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
  IF v_product.product_type='tire' AND EXISTS (
    SELECT 1
      FROM commerce.tire_specs other_spec
      JOIN commerce.products other_product
        ON other_product.id=other_spec.product_id
       AND other_product.environment=other_spec.environment
     WHERE other_spec.environment=NEW.environment
       AND other_spec.id<>COALESCE(NEW.id,gen_random_uuid())
       AND other_product.deleted_at IS NULL
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

DROP TRIGGER IF EXISTS tire_catalog_variant_unique ON commerce.tire_specs;
CREATE TRIGGER tire_catalog_variant_unique
  BEFORE INSERT OR UPDATE OF tire_size,product_id ON commerce.tire_specs
  FOR EACH ROW EXECUTE FUNCTION commerce.validate_tire_catalog_variant();

CREATE OR REPLACE FUNCTION commerce.validate_partner_stock_tire_condition()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE v_product_condition TEXT;
BEGIN
  IF TG_OP='INSERT' AND COALESCE(NEW.item_type,'pneu')='pneu'
     AND NEW.tire_condition IS NULL THEN
    RAISE EXCEPTION 'tire_condition_required';
  END IF;
  IF NEW.product_id IS NOT NULL AND COALESCE(NEW.item_type,'pneu')='pneu' THEN
    SELECT tire_condition INTO v_product_condition
      FROM commerce.products
     WHERE id=NEW.product_id AND environment=NEW.environment;
    IF v_product_condition IS DISTINCT FROM NEW.tire_condition THEN
      RAISE EXCEPTION 'partner_stock_product_condition_conflict';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS partner_stock_tire_condition_guard
  ON commerce.partner_stock_levels;
CREATE TRIGGER partner_stock_tire_condition_guard
  BEFORE INSERT OR UPDATE OF product_id,item_type,tire_condition
  ON commerce.partner_stock_levels
  FOR EACH ROW EXECUTE FUNCTION commerce.validate_partner_stock_tire_condition();

-- Smoke transacional: a mesma medida e marca podem existir nas tres condicoes,
-- e uma movimentacao nunca atravessa de uma condicao para outra.
DO $check$
DECLARE v_count INTEGER;
BEGIN
  PERFORM set_config('app.galpao_source', 'smoke_0156', true);
  INSERT INTO commerce.wholesale_stock
    (environment, measure, brand, tire_condition, quantity_on_hand, unit_cost)
  VALUES
    ('test', '0156-SMOKE', 'Marca A', 'meia_vida', 3, 10),
    ('test', '0156-SMOKE', 'Marca A', 'novo', 7, 100),
    ('test', '0156-SMOKE', 'Marca A', 'remold', 5, 50);

  UPDATE commerce.wholesale_stock
     SET quantity_on_hand = quantity_on_hand - 1
   WHERE environment = 'test'
     AND measure = '0156-SMOKE'
     AND brand = 'Marca A'
     AND tire_condition = 'novo';

  SELECT count(*) INTO v_count
    FROM commerce.wholesale_stock
   WHERE environment = 'test' AND measure = '0156-SMOKE';
  IF v_count <> 3 THEN
    RAISE EXCEPTION '0156 falhou: variantes por condicao nao ficaram separadas';
  END IF;
  IF (SELECT quantity_on_hand FROM commerce.wholesale_stock
       WHERE environment='test' AND measure='0156-SMOKE'
         AND brand='Marca A' AND tire_condition='meia_vida') <> 3
     OR
     (SELECT quantity_on_hand FROM commerce.wholesale_stock
       WHERE environment='test' AND measure='0156-SMOKE'
         AND brand='Marca A' AND tire_condition='novo') <> 6 THEN
    RAISE EXCEPTION '0156 falhou: baixa atravessou condicoes';
  END IF;

  DELETE FROM commerce.wholesale_stock
   WHERE environment='test' AND measure='0156-SMOKE';
  DELETE FROM commerce.wholesale_stock_movements
   WHERE environment='test' AND measure='0156-SMOKE';
END;
$check$;
