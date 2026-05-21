-- ============================================================
-- 0040_partner_orders_local.sql
-- Vendas locais do parceiro — silo isolado da matriz.
--
-- Decisao arquitetural (Wallace, 2026-05-19):
--   "Parceiro nao ve nada da matriz. Matriz ve tudo do parceiro."
--
-- Consequencias:
--   1. Parceiro cadastra, vende, consulta tudo na propria base local.
--   2. Vendas do parceiro NAO vao mais pra commerce.orders (que dependia
--      de commerce.products via order_items.product_id NOT NULL).
--   3. Surgem commerce.partner_orders + partner_order_items proprios.
--   4. partner_order_items referencia partner_stock_levels diretamente
--      (nao commerce.products). Parceiro pode vender qualquer item
--      que ele cadastrou, sem precisar do catalogo da matriz.
--   5. Matriz (admin) le tudo via view commerce.network_orders_unified
--      que faz UNION das duas tabelas.
--
-- O que esta migration faz:
--   1. Cria commerce.partner_orders (espelho de commerce.orders adaptado)
--   2. Cria commerce.partner_order_items referenciando partner_stock_levels
--   3. Cria commerce.register_partner_local_order(...) function
--   4. Cria commerce.cancel_partner_local_order(...) function
--   5. Cria view commerce.partner_orders_full (joins pra portal listar)
--   6. Cria view commerce.network_orders_unified (UNION pra admin ler tudo)
--
-- Invariantes:
--   - Idempotencia via UNIQUE (idempotency_key)
--   - FOR UPDATE no estoque pra impedir race entre vendas concorrentes
--   - Estoque decrementa atomicamente junto com a venda
--   - Audit em audit.events com domain='partner_orders'
--   - Vendas antigas em commerce.orders ficam la (legado/historico).
--     Nao migramos. Daqui pra frente, parceiro escreve em partner_orders.
--
-- Assinatura: Claude (Opus 4.7), 2026-05-19
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. commerce.partner_orders
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.partner_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment       env_t NOT NULL,
  unit_id           UUID NOT NULL REFERENCES core.units(id),
  customer_name     TEXT,
  customer_phone    TEXT,  -- E.164 normalizado
  total_amount      NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
  status            TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('open', 'confirmed', 'paid', 'delivered', 'cancelled')),
  payment_method    TEXT,
  fulfillment_mode  TEXT NOT NULL DEFAULT 'pickup'
                    CHECK (fulfillment_mode IN ('pickup', 'delivery')),
  delivery_address  TEXT,
  source_tag        TEXT,  -- 'walkin_balcao' | 'walkin_telefone' | 'outro' etc
  closed_by         TEXT,  -- partner:slug
  closed_at         TIMESTAMPTZ,
  idempotency_key   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

COMMENT ON TABLE commerce.partner_orders IS
  'Vendas locais do parceiro. Silo isolado da matriz: nao depende de commerce.products. Estoque decrementa via commerce.register_partner_local_order().';

CREATE UNIQUE INDEX IF NOT EXISTS partner_orders_idempotency_uniq
  ON commerce.partner_orders(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_orders_unit_created_idx
  ON commerce.partner_orders(unit_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS partner_orders_status_idx
  ON commerce.partner_orders(environment, status)
  WHERE deleted_at IS NULL;


-- ─────────────────────────────────────────────
-- 2. commerce.partner_order_items
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.partner_order_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment         env_t NOT NULL,
  order_id            UUID NOT NULL REFERENCES commerce.partner_orders(id) ON DELETE CASCADE,
  -- Aponta direto pro estoque do parceiro. Nao depende de commerce.products.
  partner_stock_id    UUID REFERENCES commerce.partner_stock_levels(id),
  -- Snapshot do item no momento da venda (pra historico mesmo se estoque mudar/sumir)
  item_name           TEXT NOT NULL,
  tire_size           TEXT,
  brand               TEXT,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  unit_price          NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0),
  discount_amount     NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE commerce.partner_order_items IS
  'Itens das vendas locais do parceiro. Snapshot dos dados do item no momento da venda (item_name, tire_size, brand) pra preservar historico se o estoque mudar nome/sumir depois.';

CREATE INDEX IF NOT EXISTS partner_order_items_order_idx
  ON commerce.partner_order_items(order_id);

CREATE INDEX IF NOT EXISTS partner_order_items_stock_idx
  ON commerce.partner_order_items(partner_stock_id)
  WHERE partner_stock_id IS NOT NULL;


-- ─────────────────────────────────────────────
-- 3. commerce.register_partner_local_order
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION commerce.register_partner_local_order(
  p_environment       TEXT,
  p_unit_id           UUID,
  p_customer_name     TEXT,
  p_customer_phone    TEXT,
  p_items             JSONB,  -- [{partner_stock_id, quantity, unit_price, discount_amount?}]
  p_payment_method    TEXT,
  p_fulfillment_mode  TEXT,
  p_delivery_address  TEXT,
  p_actor_label       TEXT,
  p_idempotency_key   TEXT,
  p_source_tag        TEXT
) RETURNS UUID AS $$
DECLARE
  v_order_id    UUID;
  v_existing    UUID;
  v_total       NUMERIC := 0;
  v_item        JSONB;
  v_stock_id    UUID;
  v_qty         INTEGER;
  v_price       NUMERIC;
  v_discount    NUMERIC;
  v_stock_row   RECORD;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'idempotency_key obrigatorio (min 8 chars)';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Pedido precisa de pelo menos 1 item';
  END IF;

  -- 1. Idempotencia
  SELECT id INTO v_existing
  FROM commerce.partner_orders
  WHERE idempotency_key = p_idempotency_key;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- 2. Calcula total + decrementa estoque atomicamente
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_stock_id := (v_item->>'partner_stock_id')::UUID;
    v_qty      := (v_item->>'quantity')::INTEGER;
    v_price    := (v_item->>'unit_price')::NUMERIC;
    v_discount := COALESCE((v_item->>'discount_amount')::NUMERIC, 0);

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'quantity invalida no item: %', v_item;
    END IF;
    IF v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION 'unit_price invalido no item: %', v_item;
    END IF;

    v_total := v_total + (v_qty * v_price - v_discount);

    -- Lock + decrement do estoque local (se houver partner_stock_id)
    IF v_stock_id IS NOT NULL THEN
      SELECT id, item_name, tire_size, brand, quantity_on_hand,
             minimum_quantity, is_tracked, deleted_at
        INTO v_stock_row
      FROM commerce.partner_stock_levels
      WHERE id = v_stock_id
        AND environment = p_environment
        AND unit_id = p_unit_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Item de estoque nao pertence a esta unidade: %', v_stock_id;
      END IF;
      IF v_stock_row.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Item de estoque inativado: %', v_stock_id;
      END IF;

      -- Decrement se rastreado e tem saldo
      IF v_stock_row.is_tracked
         AND v_stock_row.quantity_on_hand IS NOT NULL
         AND v_stock_row.quantity_on_hand >= v_qty THEN
        UPDATE commerce.partner_stock_levels
        SET quantity_on_hand = quantity_on_hand - v_qty,
            stock_status = CASE
              WHEN NOT is_tracked THEN 'not_tracked'
              WHEN quantity_on_hand - v_qty <= 0 THEN 'out_of_stock'
              WHEN minimum_quantity IS NOT NULL
                   AND quantity_on_hand - v_qty <= minimum_quantity THEN 'low_stock'
              ELSE 'in_stock'
            END,
            updated_at = now(),
            updated_by = p_actor_label
        WHERE id = v_stock_id;
      END IF;
      -- Se nao rastreado ou sem saldo, venda completa mas estoque nao mexe (intencional).
    END IF;
  END LOOP;

  -- 3. INSERT order
  INSERT INTO commerce.partner_orders (
    environment, unit_id, customer_name, customer_phone,
    total_amount, status, payment_method, fulfillment_mode, delivery_address,
    source_tag, closed_by, closed_at, idempotency_key
  ) VALUES (
    p_environment, p_unit_id,
    NULLIF(trim(COALESCE(p_customer_name, '')), ''),
    NULLIF(trim(COALESCE(p_customer_phone, '')), ''),
    v_total, 'confirmed', p_payment_method, p_fulfillment_mode, p_delivery_address,
    COALESCE(p_source_tag, 'walkin_balcao'), p_actor_label, now(), p_idempotency_key
  ) RETURNING id INTO v_order_id;

  -- 4. INSERT items (com snapshot dos dados do estoque)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_stock_id := (v_item->>'partner_stock_id')::UUID;
    v_qty      := (v_item->>'quantity')::INTEGER;
    v_price    := (v_item->>'unit_price')::NUMERIC;
    v_discount := COALESCE((v_item->>'discount_amount')::NUMERIC, 0);

    IF v_stock_id IS NOT NULL THEN
      SELECT item_name, tire_size, brand INTO v_stock_row
      FROM commerce.partner_stock_levels
      WHERE id = v_stock_id;
    ELSE
      v_stock_row := ROW(NULL, COALESCE(v_item->>'item_name', 'Item livre'), NULL, NULL)::RECORD;
    END IF;

    INSERT INTO commerce.partner_order_items (
      environment, order_id, partner_stock_id,
      item_name, tire_size, brand,
      quantity, unit_price, discount_amount
    ) VALUES (
      p_environment, v_order_id, v_stock_id,
      COALESCE(v_stock_row.item_name, v_item->>'item_name', 'Item livre'),
      v_stock_row.tire_size,
      v_stock_row.brand,
      v_qty, v_price, v_discount
    );
  END LOOP;

  -- 5. Audit
  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, idempotency_key, payload_after
  ) VALUES (
    p_environment, 'partner_orders', 'commerce.partner_orders', v_order_id,
    'partner_order_created', p_actor_label, p_idempotency_key,
    jsonb_build_object('total', v_total, 'items', p_items, 'unit_id', p_unit_id)
  );

  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION commerce.register_partner_local_order IS
  'Registra venda local do parceiro + decrementa estoque atomicamente. Nao depende de commerce.products. Idempotente via idempotency_key UNIQUE.';


-- ─────────────────────────────────────────────
-- 4. commerce.cancel_partner_local_order
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION commerce.cancel_partner_local_order(
  p_order_id      UUID,
  p_actor_label   TEXT,
  p_reason        TEXT
) RETURNS VOID AS $$
DECLARE
  v_environment   TEXT;
  v_unit_id       UUID;
  v_previous      TEXT;
  v_item          RECORD;
BEGIN
  SELECT environment, unit_id, status
    INTO v_environment, v_unit_id, v_previous
  FROM commerce.partner_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_previous IS NULL THEN
    RAISE EXCEPTION 'Venda nao encontrada: %', p_order_id;
  END IF;
  IF v_previous = 'cancelled' THEN
    RAISE EXCEPTION 'Venda ja cancelada: %', p_order_id;
  END IF;

  -- Restaura estoque (item por item)
  FOR v_item IN
    SELECT partner_stock_id, quantity
    FROM commerce.partner_order_items
    WHERE order_id = p_order_id AND environment = v_environment
  LOOP
    IF v_item.partner_stock_id IS NOT NULL THEN
      UPDATE commerce.partner_stock_levels
      SET quantity_on_hand = COALESCE(quantity_on_hand, 0) + v_item.quantity,
          stock_status = CASE
            WHEN NOT is_tracked THEN 'not_tracked'
            WHEN COALESCE(quantity_on_hand, 0) + v_item.quantity <= 0 THEN 'out_of_stock'
            WHEN minimum_quantity IS NOT NULL
                 AND COALESCE(quantity_on_hand, 0) + v_item.quantity <= minimum_quantity THEN 'low_stock'
            ELSE 'in_stock'
          END,
          updated_at = now(),
          updated_by = p_actor_label
      WHERE id = v_item.partner_stock_id
        AND environment = v_environment
        AND unit_id = v_unit_id
        AND deleted_at IS NULL
        AND is_tracked;
    END IF;
  END LOOP;

  -- Marca cancelada
  UPDATE commerce.partner_orders
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_order_id;

  -- Audit
  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, payload_after
  ) VALUES (
    v_environment, 'partner_orders', 'commerce.partner_orders', p_order_id,
    'partner_order_cancelled', p_actor_label,
    jsonb_build_object('reason', p_reason, 'previous_status', v_previous)
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION commerce.cancel_partner_local_order IS
  'Cancela venda local do parceiro + restaura estoque. Idempotente quanto a status (erro se ja cancelada).';


-- ─────────────────────────────────────────────
-- 5. View commerce.partner_orders_full (pro portal listar)
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW commerce.partner_orders_full AS
SELECT
  po.id              AS order_id,
  po.environment,
  po.unit_id,
  po.customer_name   AS contact_name,
  po.customer_phone  AS contact_phone,
  po.total_amount,
  po.status,
  po.payment_method,
  po.fulfillment_mode,
  po.delivery_address,
  po.source_tag,
  po.closed_by       AS registered_by,
  po.closed_at,
  po.created_at,
  po.updated_at,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'item_name', poi.item_name,
        'tire_size', poi.tire_size,
        'brand',     poi.brand,
        'quantity',  poi.quantity,
        'unit_price', poi.unit_price,
        'discount_amount', poi.discount_amount,
        'partner_stock_id', poi.partner_stock_id
      )
      ORDER BY poi.created_at
    ) FILTER (WHERE poi.id IS NOT NULL),
    '[]'::jsonb
  ) AS items
FROM commerce.partner_orders po
LEFT JOIN commerce.partner_order_items poi
  ON poi.order_id = po.id AND poi.environment = po.environment
WHERE po.deleted_at IS NULL
GROUP BY po.id;

COMMENT ON VIEW commerce.partner_orders_full IS
  'Vendas do parceiro com items agregados em JSONB. Usado pelo portal parceiro pra listar Vendas recentes.';


-- ─────────────────────────────────────────────
-- 6. View commerce.network_orders_unified (pro admin ler tudo)
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW commerce.network_orders_unified AS

-- Vendas da matriz (commerce.orders)
SELECT
  'matriz'::text                       AS source_table,
  o.id                                 AS order_id,
  o.environment,
  o.unit_id,
  NULL::text                           AS unit_slug,
  'Matriz'::text                       AS unit_label,
  ct.name                              AS customer_name,
  ct.phone_e164                        AS customer_phone,
  o.total_amount,
  o.status,
  o.payment_method,
  o.fulfillment_mode,
  o.delivery_address,
  o.source                             AS source_tag,
  o.closed_by                          AS registered_by,
  o.closed_at,
  o.created_at,
  o.updated_at
FROM commerce.orders o
LEFT JOIN core.contacts ct
  ON ct.id = o.contact_id
 AND ct.environment = o.environment

UNION ALL

-- Vendas dos parceiros (commerce.partner_orders)
SELECT
  'partner'::text                      AS source_table,
  po.id                                AS order_id,
  po.environment,
  po.unit_id,
  pu.slug                              AS unit_slug,
  pu.display_name                      AS unit_label,
  po.customer_name,
  po.customer_phone,
  po.total_amount,
  po.status,
  po.payment_method,
  po.fulfillment_mode,
  po.delivery_address,
  po.source_tag,
  po.closed_by                         AS registered_by,
  po.closed_at,
  po.created_at,
  po.updated_at
FROM commerce.partner_orders po
LEFT JOIN network.partner_units pu
  ON pu.id = po.unit_id
 AND pu.environment = po.environment
 AND pu.deleted_at IS NULL
WHERE po.deleted_at IS NULL;

COMMENT ON VIEW commerce.network_orders_unified IS
  'Vendas consolidadas da rede: matriz + parceiros. Read-only. Painel admin consome pra ver tudo. Parceiros nao tem acesso a essa view — ficam isolados via app-layer (e RLS quando entrar na Fase 2).';
