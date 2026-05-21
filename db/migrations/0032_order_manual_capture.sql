-- ============================================================
-- 0032_order_manual_capture.sql
-- Painel Fase 1 — captura manual de venda pelo humano.
--
-- O que esta migration faz:
--   1. Cria core.units (tabela de unidades de loja, inicia com 'main')
--   2. Cria schema audit + audit.events (trilha imutavel de mudancas)
--   3. Adiciona em commerce.orders: idempotency_key, source, unit_id,
--      promoted_from_draft_id (reusa closed_by/closed_at existentes
--      para gravar quem fechou e quando)
--   4. Adiciona constraint de status em commerce.orders
--   5. Cria commerce.register_manual_order(...) com idempotencia
--      e lock no draft (FOR UPDATE) para evitar duplo registro
--   6. Cria commerce.cancel_manual_order(...) que grava audit
--
-- Invariantes:
--   - register_manual_order eh idempotente via UNIQUE (idempotency_key)
--   - Dois operadores no mesmo draft: o segundo recebe erro claro
--   - Nada de baixa automatica de estoque agora (Fase 1)
--   - audit.events grava todas as mutacoes feitas via function
--
-- Decisao 2026-05-18:
--   - unit_id soh aqui (commerce.orders), nao nas outras tabelas
--   - Acesso pela internet -> ADMIN_AUTH_TOKEN sera critico no Fastify
--   - Retencao audit.events: pra sempre, sem job de purge
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. core.units (unidades de loja)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.units (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT units_slug_unique_per_env UNIQUE (environment, slug)
);

COMMENT ON TABLE core.units IS
  'Unidades de loja. Inicia com slug=main. Multi-unidade real chega na Fase 2.';

-- Popula unidades default (uma por environment ativo)
INSERT INTO core.units (environment, slug, name)
SELECT DISTINCT environment, 'main', 'Loja Principal'
FROM core.conversations
WHERE environment IS NOT NULL
ON CONFLICT (environment, slug) DO NOTHING;

-- Caso ainda nao haja nenhum environment com conversa, garante prod
INSERT INTO core.units (environment, slug, name)
VALUES ('prod', 'main', 'Loja Principal')
ON CONFLICT (environment, slug) DO NOTHING;


-- ─────────────────────────────────────────────
-- 2. Schema audit + audit.events
-- ─────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     TEXT NOT NULL,
  domain          TEXT NOT NULL,
  entity_table    TEXT NOT NULL,
  entity_id       UUID,
  event_type      TEXT NOT NULL,
  actor_label     TEXT,
  idempotency_key TEXT,
  payload_before  JSONB,
  payload_after   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit.events IS
  'Trilha imutavel de eventos do painel. Populada apenas por functions controladas (sem triggers globais na Fase 1). Retencao: indefinida.';

COMMENT ON COLUMN audit.events.domain IS
  'Dominio funcional do evento: orders, stock, product, shadow, etc.';

COMMENT ON COLUMN audit.events.entity_table IS
  'Nome qualificado da tabela alvo: commerce.orders, agent.order_drafts, etc.';

CREATE INDEX IF NOT EXISTS idx_audit_events_entity
  ON audit.events(entity_table, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created
  ON audit.events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_domain
  ON audit.events(domain, created_at DESC);


-- ─────────────────────────────────────────────
-- 3. Novas colunas em commerce.orders
-- ─────────────────────────────────────────────
ALTER TABLE commerce.orders
  ADD COLUMN IF NOT EXISTS idempotency_key       TEXT,
  ADD COLUMN IF NOT EXISTS source                TEXT,
  ADD COLUMN IF NOT EXISTS unit_id               UUID,
  ADD COLUMN IF NOT EXISTS promoted_from_draft_id UUID;

-- Default e check em source (apos addColumn pra nao falhar em ambiente vazio)
ALTER TABLE commerce.orders
  ALTER COLUMN source SET DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'orders_source_check'
      AND table_schema = 'commerce' AND table_name = 'orders'
  ) THEN
    ALTER TABLE commerce.orders
      ADD CONSTRAINT orders_source_check
      CHECK (source IN ('manual', 'bot_promoted', 'erp_import'));
  END IF;
END $$;

-- Unicidade da chave de idempotencia
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'commerce' AND indexname = 'orders_idempotency_key_uniq'
  ) THEN
    CREATE UNIQUE INDEX orders_idempotency_key_uniq
      ON commerce.orders(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  END IF;
END $$;

-- FKs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'orders_unit_id_fkey'
      AND table_schema = 'commerce' AND table_name = 'orders'
  ) THEN
    ALTER TABLE commerce.orders
      ADD CONSTRAINT orders_unit_id_fkey
      FOREIGN KEY (unit_id) REFERENCES core.units(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'orders_promoted_from_draft_fkey'
      AND table_schema = 'commerce' AND table_name = 'orders'
  ) THEN
    ALTER TABLE commerce.orders
      ADD CONSTRAINT orders_promoted_from_draft_fkey
      FOREIGN KEY (promoted_from_draft_id) REFERENCES agent.order_drafts(id);
  END IF;
END $$;

-- Indexes uteis pro painel
CREATE INDEX IF NOT EXISTS idx_orders_unit_status_created
  ON commerce.orders(unit_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_source_created
  ON commerce.orders(source, created_at DESC);

-- O schema original de commerce.orders tinha status:
-- open, paid, delivered, cancelled. O painel precisa diferenciar pedido
-- registrado/confirmado pelo humano antes de pagamento/entrega.
ALTER TABLE commerce.orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE commerce.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('open', 'confirmed', 'paid', 'delivered', 'cancelled'));

COMMENT ON COLUMN commerce.orders.idempotency_key IS
  'Chave gerada pelo painel para evitar duplo registro (UUID por sessao do modal).';
COMMENT ON COLUMN commerce.orders.source IS
  'Origem do registro: manual (painel humano), bot_promoted (auto pelo bot), erp_import.';
COMMENT ON COLUMN commerce.orders.unit_id IS
  'Unidade de loja. Multi-unidade comeca aqui. Outras tabelas ganham unit_id na Fase 2.';
COMMENT ON COLUMN commerce.orders.promoted_from_draft_id IS
  'Quando o pedido veio de um draft da Atendente, referencia agent.order_drafts.id.';


-- ─────────────────────────────────────────────
-- 4. commerce.register_manual_order(...)
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION commerce.register_manual_order(
  p_environment        TEXT,
  p_contact_id         UUID,
  p_conversation_id    UUID,
  p_draft_id           UUID,           -- pode ser NULL (venda sem draft)
  p_unit_id            UUID,
  p_items              JSONB,          -- [{product_id, quantity, unit_price, discount_amount?}]
  p_payment_method     TEXT,
  p_fulfillment_mode   TEXT,
  p_delivery_address   TEXT,
  p_actor_label        TEXT,
  p_idempotency_key    TEXT
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

  -- 1. Idempotencia: se ja existe, retorna o mesmo order_id
  SELECT id INTO v_existing
  FROM commerce.orders
  WHERE idempotency_key = p_idempotency_key;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- 2. Lock no draft (se houver) para impedir promocao concorrente
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

  -- 3. Calcula total
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

  -- 4. INSERT order
  INSERT INTO commerce.orders (
    environment, contact_id, source_conversation_id,
    total_amount, status, fulfillment_mode, payment_method,
    delivery_address, closed_by, closed_at,
    idempotency_key, source, unit_id, promoted_from_draft_id
  ) VALUES (
    p_environment, p_contact_id, p_conversation_id,
    v_total, 'confirmed', p_fulfillment_mode, p_payment_method,
    p_delivery_address, p_actor_label, now(),
    p_idempotency_key, 'manual', v_unit_id, p_draft_id
  ) RETURNING id INTO v_order_id;

  -- 5. INSERT items
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

  -- 6. Vincula draft -> order
  IF p_draft_id IS NOT NULL THEN
    UPDATE agent.order_drafts
    SET promoted_order_id = v_order_id,
        draft_status = 'promoted',
        promoted_by = p_actor_label,
        promoted_at = now(),
        updated_at = now()
    WHERE id = p_draft_id;
  END IF;

  -- 7. Audit
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
      'payment_method', p_payment_method,
      'fulfillment_mode', p_fulfillment_mode
    )
  );

  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION commerce.register_manual_order IS
  'Registro de venda manual via painel humano. Idempotente, atomica, com audit. Painel chama esta function (nao escreve direto em commerce.orders).';


-- ─────────────────────────────────────────────
-- 5. commerce.cancel_manual_order(...)
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION commerce.cancel_manual_order(
  p_order_id     UUID,
  p_actor_label  TEXT,
  p_reason       TEXT
) RETURNS VOID AS $$
DECLARE
  v_environment    TEXT;
  v_previous_status TEXT;
  v_payload_before JSONB;
BEGIN
  SELECT environment, status,
         jsonb_build_object('status', status, 'total_amount', total_amount)
    INTO v_environment, v_previous_status, v_payload_before
  FROM commerce.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_previous_status IS NULL THEN
    RAISE EXCEPTION 'Pedido nao encontrado: %', p_order_id;
  END IF;

  IF v_previous_status = 'cancelled' THEN
    RAISE EXCEPTION 'Pedido ja cancelado: %', p_order_id;
  END IF;

  UPDATE commerce.orders
  SET status = 'cancelled',
      updated_at = now()
  WHERE id = p_order_id;

  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, payload_before, payload_after
  ) VALUES (
    v_environment, 'orders', 'commerce.orders', p_order_id, 'manual_order_cancelled',
    p_actor_label,
    v_payload_before,
    jsonb_build_object('status', 'cancelled', 'reason', p_reason)
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION commerce.cancel_manual_order IS
  'Cancela pedido manual. Nao deleta. Grava audit. Operador deve recriar pedido novo se quiser corrigir (fluxo cancelar+refazer).';
