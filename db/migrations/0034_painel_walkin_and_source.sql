-- ============================================================
-- 0034_painel_walkin_and_source.sql
-- Painel Fase 1 - venda sem Chatwoot e origem comercial.
--
-- Motivacao (2026-05-19):
--   Durante o shadow, Wallace fecha vendas manualmente. Algumas vendas
--   vem de conversas Chatwoot; outras vem de balcao, telefone ou indicacao.
--   Vendas sem Chatwoot nao devem criar contatos fake em core.contacts,
--   porque core.* e a camada normalizada do Chatwoot.
--
-- O que esta migration faz:
--   1. Expande commerce.orders.source.
--   2. Recria commerce.register_manual_order(...) com source_tag opcional.
--   3. Cria commerce.customers para clientes operacionais fora do Chatwoot.
--   4. Adiciona commerce.orders.customer_id e permite order com contact_id
--      OU customer_id.
--   5. Cria commerce.register_walkin_order(...), idempotente e auditada.
--   6. Recria dashboard.pedidos_recentes para exibir contact/customer.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Expande CHECK de commerce.orders.source
-- ------------------------------------------------------------
ALTER TABLE commerce.orders
  DROP CONSTRAINT IF EXISTS orders_source_check;

ALTER TABLE commerce.orders
  ADD CONSTRAINT orders_source_check
  CHECK (source IN (
    'manual',
    'bot_promoted',
    'erp_import',
    'chatwoot_com_bot',
    'chatwoot_sem_bot',
    'walkin_balcao',
    'walkin_telefone',
    'walkin_outro'
  ));


-- ------------------------------------------------------------
-- 2. Recria register_manual_order com source_tag
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS commerce.register_manual_order(
  TEXT, UUID, UUID, UUID, UUID, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT
);

CREATE OR REPLACE FUNCTION commerce.register_manual_order(
  p_environment        TEXT,
  p_contact_id         UUID,
  p_conversation_id    UUID,
  p_draft_id           UUID,
  p_unit_id            UUID,
  p_items              JSONB,
  p_payment_method     TEXT,
  p_fulfillment_mode   TEXT,
  p_delivery_address   TEXT,
  p_actor_label        TEXT,
  p_idempotency_key    TEXT,
  p_source_tag         TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_order_id   UUID;
  v_existing   UUID;
  v_unit_id    UUID;
  v_total      NUMERIC := 0;
  v_item       JSONB;
  v_qty        INTEGER;
  v_price      NUMERIC;
  v_discount   NUMERIC;
  v_source     TEXT;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'idempotency_key obrigatorio (min 8 chars)';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Pedido precisa de pelo menos 1 item';
  END IF;

  v_unit_id := p_unit_id;
  IF v_unit_id IS NULL THEN
    SELECT id INTO v_unit_id
    FROM core.units
    WHERE environment = p_environment
      AND slug = 'main'
      AND is_active
    LIMIT 1;
  END IF;

  IF v_unit_id IS NULL THEN
    RAISE EXCEPTION 'unit_id obrigatorio ou unidade main ausente para environment=%', p_environment;
  END IF;

  IF p_source_tag IS NULL THEN
    IF p_draft_id IS NOT NULL THEN
      v_source := 'chatwoot_com_bot';
    ELSE
      v_source := 'chatwoot_sem_bot';
    END IF;
  ELSE
    v_source := p_source_tag;
  END IF;

  IF v_source NOT IN ('chatwoot_com_bot', 'chatwoot_sem_bot') THEN
    RAISE EXCEPTION 'source_tag invalido para venda Chatwoot: %', v_source;
  END IF;

  SELECT id INTO v_existing
  FROM commerce.orders
  WHERE idempotency_key = p_idempotency_key;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  IF p_draft_id IS NOT NULL THEN
    PERFORM 1 FROM agent.order_drafts WHERE id = p_draft_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Draft nao encontrado: %', p_draft_id;
    END IF;

    IF (SELECT promoted_order_id FROM agent.order_drafts WHERE id = p_draft_id) IS NOT NULL THEN
      RAISE EXCEPTION 'Pedido ja registrado para este draft (draft_id=%)', p_draft_id
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := (v_item->>'quantity')::INTEGER;
    v_price := (v_item->>'unit_price')::NUMERIC;
    v_discount := COALESCE((v_item->>'discount_amount')::NUMERIC, 0);

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'quantity invalida no item: %', v_item;
    END IF;
    IF v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION 'unit_price invalido no item: %', v_item;
    END IF;

    v_total := v_total + (v_qty * v_price - v_discount);
  END LOOP;

  INSERT INTO commerce.orders (
    environment, contact_id, source_conversation_id,
    total_amount, status, fulfillment_mode, payment_method,
    delivery_address, closed_by, closed_at,
    idempotency_key, source, unit_id, promoted_from_draft_id
  ) VALUES (
    p_environment, p_contact_id, p_conversation_id,
    v_total, 'confirmed', p_fulfillment_mode, p_payment_method,
    p_delivery_address, p_actor_label, now(),
    p_idempotency_key, v_source, v_unit_id, p_draft_id
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO commerce.order_items (
      environment, order_id, product_id, quantity, unit_price, discount_amount
    ) VALUES (
      p_environment, v_order_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'quantity')::INTEGER,
      (v_item->>'unit_price')::NUMERIC,
      COALESCE((v_item->>'discount_amount')::NUMERIC, 0)
    );
  END LOOP;

  IF p_draft_id IS NOT NULL THEN
    UPDATE agent.order_drafts
    SET promoted_order_id = v_order_id,
        draft_status = 'promoted',
        promoted_by = p_actor_label,
        promoted_at = now(),
        updated_at = now()
    WHERE id = p_draft_id;
  END IF;

  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, idempotency_key, payload_after
  ) VALUES (
    p_environment, 'orders', 'commerce.orders', v_order_id, 'manual_order_created',
    p_actor_label, p_idempotency_key,
    jsonb_build_object(
      'total', v_total,
      'items', p_items,
      'draft_id', p_draft_id,
      'unit_id', v_unit_id,
      'source', v_source,
      'payment_method', p_payment_method,
      'fulfillment_mode', p_fulfillment_mode
    )
  );

  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION commerce.register_manual_order IS
  'Registro de venda manual via Chatwoot no painel. Idempotente, atomica, com audit. source_tag deriva auto se NULL.';


-- ------------------------------------------------------------
-- 3. commerce.customers
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce.customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   env_t NOT NULL,
  name          TEXT,
  phone_e164    TEXT,
  email         TEXT,
  source        TEXT NOT NULL DEFAULT 'walkin'
                CHECK (source IN ('walkin', 'chatwoot_manual', 'erp_import')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

COMMENT ON TABLE commerce.customers IS
  'Clientes comerciais fora da normalizacao Chatwoot. Usado por vendas walkin/balcao e futuras importacoes ERP.';

COMMENT ON COLUMN commerce.customers.phone_e164 IS
  'Telefone em E.164 quando conhecido. NULL significa desconhecido.';

CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_uniq
  ON commerce.customers(environment, phone_e164)
  WHERE phone_e164 IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS customers_name_trgm_idx
  ON commerce.customers USING GIN (name gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS customers_created_idx
  ON commerce.customers(environment, created_at DESC)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS env_immutable_customers ON commerce.customers;
CREATE TRIGGER env_immutable_customers
  BEFORE UPDATE OF environment ON commerce.customers
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();


-- ------------------------------------------------------------
-- 4. commerce.orders aceita contact_id OU customer_id
-- ------------------------------------------------------------
ALTER TABLE commerce.orders
  ADD COLUMN IF NOT EXISTS customer_id UUID;

ALTER TABLE commerce.orders
  ALTER COLUMN contact_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'orders_customer_id_fkey'
      AND table_schema = 'commerce' AND table_name = 'orders'
  ) THEN
    ALTER TABLE commerce.orders
      ADD CONSTRAINT orders_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES commerce.customers(id);
  END IF;
END $$;

ALTER TABLE commerce.orders
  DROP CONSTRAINT IF EXISTS orders_party_check;

ALTER TABLE commerce.orders
  ADD CONSTRAINT orders_party_check
  CHECK (contact_id IS NOT NULL OR customer_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS orders_customer_idx
  ON commerce.orders(customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

DROP TRIGGER IF EXISTS env_match_orders_customer ON commerce.orders;
CREATE TRIGGER env_match_orders_customer
  BEFORE INSERT OR UPDATE OF customer_id ON commerce.orders
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'customers', 'customer_id');

COMMENT ON COLUMN commerce.orders.customer_id IS
  'Cliente comercial fora do Chatwoot. Para pedidos via Chatwoot, usar contact_id; para walkin/balcao, usar customer_id.';


-- ------------------------------------------------------------
-- 5. find_or_create_customer
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION commerce.find_or_create_customer(
  p_environment TEXT,
  p_name        TEXT,
  p_phone       TEXT
) RETURNS UUID AS $$
DECLARE
  v_customer_id  UUID;
  v_phone_clean  TEXT;
  v_name_clean   TEXT;
BEGIN
  v_phone_clean := NULLIF(trim(COALESCE(p_phone, '')), '');
  v_name_clean := NULLIF(trim(COALESCE(p_name, '')), '');

  IF v_phone_clean IS NOT NULL THEN
    SELECT id INTO v_customer_id
    FROM commerce.customers
    WHERE environment::TEXT = p_environment
      AND phone_e164 = v_phone_clean
      AND deleted_at IS NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1;

    IF v_customer_id IS NOT NULL THEN
      UPDATE commerce.customers
      SET name = COALESCE(v_name_clean, name),
          updated_at = now()
      WHERE id = v_customer_id;

      RETURN v_customer_id;
    END IF;
  END IF;

  INSERT INTO commerce.customers (
    environment, name, phone_e164, source
  ) VALUES (
    p_environment::env_t,
    COALESCE(v_name_clean, 'Cliente Balcao'),
    v_phone_clean,
    'walkin'
  )
  RETURNING id INTO v_customer_id;

  RETURN v_customer_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION commerce.find_or_create_customer IS
  'Recupera ou cria cliente operacional para venda walkin. Reaproveita por phone_e164 quando informado.';


-- ------------------------------------------------------------
-- 6. register_walkin_order
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION commerce.register_walkin_order(
  p_environment       TEXT,
  p_customer_name     TEXT,
  p_customer_phone    TEXT,
  p_unit_id           UUID,
  p_items             JSONB,
  p_payment_method    TEXT,
  p_fulfillment_mode  TEXT,
  p_delivery_address  TEXT,
  p_actor_label       TEXT,
  p_idempotency_key   TEXT,
  p_source_tag        TEXT DEFAULT 'walkin_balcao'
) RETURNS UUID AS $$
DECLARE
  v_customer_id UUID;
  v_order_id    UUID;
  v_unit_id     UUID;
  v_existing    UUID;
  v_total       NUMERIC := 0;
  v_item        JSONB;
  v_qty         INTEGER;
  v_price       NUMERIC;
  v_discount    NUMERIC;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'idempotency_key obrigatorio (min 8 chars)';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Pedido precisa de pelo menos 1 item';
  END IF;

  IF p_source_tag NOT IN ('walkin_balcao', 'walkin_telefone', 'walkin_outro') THEN
    RAISE EXCEPTION 'source_tag invalido para venda walkin: %', p_source_tag;
  END IF;

  SELECT id INTO v_existing
  FROM commerce.orders
  WHERE idempotency_key = p_idempotency_key;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  v_unit_id := p_unit_id;
  IF v_unit_id IS NULL THEN
    SELECT id INTO v_unit_id
    FROM core.units
    WHERE environment = p_environment AND slug = 'main' AND is_active
    LIMIT 1;
  END IF;

  IF v_unit_id IS NULL THEN
    RAISE EXCEPTION 'unidade main ausente para environment=%', p_environment;
  END IF;

  v_customer_id := commerce.find_or_create_customer(
    p_environment, p_customer_name, p_customer_phone
  );

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := (v_item->>'quantity')::INTEGER;
    v_price := (v_item->>'unit_price')::NUMERIC;
    v_discount := COALESCE((v_item->>'discount_amount')::NUMERIC, 0);

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'quantity invalida no item: %', v_item;
    END IF;
    IF v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION 'unit_price invalido no item: %', v_item;
    END IF;

    v_total := v_total + (v_qty * v_price - v_discount);
  END LOOP;

  INSERT INTO commerce.orders (
    environment, contact_id, customer_id, source_conversation_id,
    total_amount, status, fulfillment_mode, payment_method,
    delivery_address, closed_by, closed_at,
    idempotency_key, source, unit_id
  ) VALUES (
    p_environment, NULL, v_customer_id, NULL,
    v_total, 'confirmed', p_fulfillment_mode, p_payment_method,
    p_delivery_address, p_actor_label, now(),
    p_idempotency_key, p_source_tag, v_unit_id
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO commerce.order_items (
      environment, order_id, product_id, quantity, unit_price, discount_amount
    ) VALUES (
      p_environment, v_order_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'quantity')::INTEGER,
      (v_item->>'unit_price')::NUMERIC,
      COALESCE((v_item->>'discount_amount')::NUMERIC, 0)
    );
  END LOOP;

  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, idempotency_key, payload_after
  ) VALUES (
    p_environment, 'orders', 'commerce.orders', v_order_id, 'walkin_order_created',
    p_actor_label, p_idempotency_key,
    jsonb_build_object(
      'total', v_total,
      'items', p_items,
      'unit_id', v_unit_id,
      'customer_id', v_customer_id,
      'customer_name', p_customer_name,
      'customer_phone', p_customer_phone,
      'source_tag', p_source_tag,
      'payment_method', p_payment_method,
      'fulfillment_mode', p_fulfillment_mode
    )
  );

  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION commerce.register_walkin_order IS
  'Registra venda sem conversa Chatwoot (balcao, telefone, indicacao). Cria commerce.customers se necessario. Idempotente, atomica, com audit.';


-- ------------------------------------------------------------
-- 7. Recria view de pedidos para mostrar contact OU customer
-- ------------------------------------------------------------
DROP VIEW IF EXISTS dashboard.pedidos_recentes;

CREATE VIEW dashboard.pedidos_recentes AS
SELECT
  o.environment,
  o.id                  AS order_id,
  o.created_at,
  o.unit_id,
  u.slug                AS unit_slug,
  u.name                AS unit_name,
  o.contact_id,
  o.customer_id,
  COALESCE(ct.name, cu.name, 'Cliente') AS contact_name,
  COALESCE(ct.phone_e164, cu.phone_e164) AS contact_phone,
  o.source,
  o.status,
  o.payment_method,
  o.fulfillment_mode,
  o.delivery_address,
  o.total_amount,
  o.closed_by           AS registered_by,
  o.closed_at           AS registered_at,
  o.promoted_from_draft_id,
  (SELECT jsonb_agg(jsonb_build_object(
    'product_id', oi.product_id,
    'product_name', p.product_name,
    'product_code', p.product_code,
    'quantity', oi.quantity,
    'unit_price', oi.unit_price,
    'discount_amount', oi.discount_amount,
    'subtotal', (oi.quantity * oi.unit_price - oi.discount_amount)
  ) ORDER BY oi.created_at)
    FROM commerce.order_items oi
    LEFT JOIN commerce.products p ON p.id = oi.product_id AND p.environment = oi.environment
    WHERE oi.order_id = o.id AND oi.environment = o.environment) AS items
FROM commerce.orders o
LEFT JOIN core.units u ON u.id = o.unit_id
LEFT JOIN core.contacts ct ON ct.id = o.contact_id AND ct.environment = o.environment
LEFT JOIN commerce.customers cu ON cu.id = o.customer_id AND cu.environment = o.environment;

COMMENT ON VIEW dashboard.pedidos_recentes IS
  'Pedidos com itens, unidade e comprador agregado. Usa core.contacts para Chatwoot e commerce.customers para venda sem conversa.';
