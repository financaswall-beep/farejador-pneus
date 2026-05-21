-- ============================================================
-- 0042_partner_sale_consistency.sql
-- Reconstrucao em arquivo da migration aplicada via MCP Supabase em 2026-05-20.
--
-- Objetivo:
--   - BUG #2: levantar EXCEPTION quando saldo insuficiente em item rastreado
--     (antes vendia silenciosamente sem decrementar).
--   - BUG #5: separar audit de movimento de estoque (stock_decrement_sale)
--     do audit de venda (partner_order_created).
--
-- Escopo:
--   Recria commerce.register_partner_local_order. Function cancel_partner_local_order
--   nao muda (continua igual a 0040).
--
-- Idempotente: usa CREATE OR REPLACE. Pode aplicar varias vezes sem efeito colateral.
--
-- Auditoria pre-aplicacao (extraida de prod via pg_get_functiondef em 2026-05-21):
--   versao prod tinha 6268 chars (vs ~4000 da 0040).
--   FKs ja com ON DELETE SET NULL aplicadas pela 0043.
--
-- Reconstruido a partir de pg_get_functiondef do banco prod.
-- Assinatura: Claude (Opus 4.7), 2026-05-21
-- ============================================================

CREATE OR REPLACE FUNCTION commerce.register_partner_local_order(
  p_environment       TEXT,
  p_unit_id           UUID,
  p_customer_name     TEXT,
  p_customer_phone    TEXT,
  p_items             JSONB,
  p_payment_method    TEXT,
  p_fulfillment_mode  TEXT,
  p_delivery_address  TEXT,
  p_actor_label       TEXT,
  p_idempotency_key   TEXT,
  p_source_tag        TEXT
) RETURNS UUID
LANGUAGE plpgsql
AS $$
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
  v_moves       JSONB := '[]'::jsonb;
  v_new_qty     INTEGER;
  v_new_status  TEXT;
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

  -- 2. Loop 1: valida saldo + decrementa estoque + monta lista de movimentos
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

      -- BUG #2 corrigido: bloqueia venda quando item rastreado nao tem saldo
      IF v_stock_row.is_tracked
         AND v_stock_row.quantity_on_hand IS NOT NULL
         AND v_stock_row.quantity_on_hand < v_qty THEN
        RAISE EXCEPTION 'Estoque insuficiente para "%": disponivel %, pedido %',
          v_stock_row.item_name, v_stock_row.quantity_on_hand, v_qty
          USING ERRCODE = '23514';
      END IF;

      -- Decrementa se rastreado (saldo ja validado acima)
      IF v_stock_row.is_tracked
         AND v_stock_row.quantity_on_hand IS NOT NULL THEN
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
        WHERE id = v_stock_id
        RETURNING quantity_on_hand, stock_status INTO v_new_qty, v_new_status;

        -- Coleta movimento pra audit ao fim (BUG #5)
        v_moves := v_moves || jsonb_build_object(
          'stock_id', v_stock_id,
          'item_name', v_stock_row.item_name,
          'delta', -v_qty,
          'new_qty', v_new_qty,
          'new_status', v_new_status
        );
      END IF;
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

  -- 4. Loop 2: insere items com snapshot
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_stock_id := (v_item->>'partner_stock_id')::UUID;
    v_qty      := (v_item->>'quantity')::INTEGER;
    v_price    := (v_item->>'unit_price')::NUMERIC;
    v_discount := COALESCE((v_item->>'discount_amount')::NUMERIC, 0);

    IF v_stock_id IS NOT NULL THEN
      SELECT item_name, tire_size, brand INTO v_stock_row
      FROM commerce.partner_stock_levels
      WHERE id = v_stock_id;

      INSERT INTO commerce.partner_order_items (
        environment, order_id, partner_stock_id,
        item_name, tire_size, brand,
        quantity, unit_price, discount_amount
      ) VALUES (
        p_environment, v_order_id, v_stock_id,
        v_stock_row.item_name,
        v_stock_row.tire_size,
        v_stock_row.brand,
        v_qty, v_price, v_discount
      );
    ELSE
      INSERT INTO commerce.partner_order_items (
        environment, order_id, partner_stock_id,
        item_name, tire_size, brand,
        quantity, unit_price, discount_amount
      ) VALUES (
        p_environment, v_order_id, NULL,
        COALESCE(v_item->>'item_name', 'Item livre'),
        NULL, NULL,
        v_qty, v_price, v_discount
      );
    END IF;
  END LOOP;

  -- 5. Audit da venda
  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, idempotency_key, payload_after
  ) VALUES (
    p_environment, 'partner_orders', 'commerce.partner_orders', v_order_id,
    'partner_order_created', p_actor_label, p_idempotency_key,
    jsonb_build_object('total', v_total, 'items', p_items, 'unit_id', p_unit_id)
  );

  -- 6. BUG #5 corrigido: audit de movimento de estoque separado
  IF jsonb_array_length(v_moves) > 0 THEN
    INSERT INTO audit.events (
      environment, domain, entity_table, entity_id, event_type,
      actor_label, payload_after
    ) VALUES (
      p_environment, 'stock', 'commerce.partner_stock_levels', v_order_id,
      'stock_decrement_sale', p_actor_label,
      jsonb_build_object('order_id', v_order_id, 'moves', v_moves)
    );
  END IF;

  RETURN v_order_id;
END;
$$;

COMMENT ON FUNCTION commerce.register_partner_local_order IS
  'Registra venda local do parceiro + decrementa estoque atomicamente. Idempotente via idempotency_key. Bloqueia venda com saldo insuficiente. Emite 2 eventos: partner_order_created + stock_decrement_sale.';
