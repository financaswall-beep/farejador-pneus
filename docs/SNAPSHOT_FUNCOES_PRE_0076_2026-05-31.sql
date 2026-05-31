-- ============================================================
-- SNAPSHOT DE ROLLBACK — corpos ATUAIS em produção ANTES da migration 0076
-- (estoque reservado / entrega COD).
--
-- Capturado de prod (Supabase projeto Farejador, aoqtgwzeyznycuakrdhp) via
-- pg_get_functiondef em 2026-05-31, por Claude (Opus 4.8).
--
-- Finalidade:
--   1. ROLLBACK: se a 0076 quebrar em produção, reaplicar este arquivo restaura
--      o comportamento anterior das DUAS funções de uma vez.
--   2. BASE FIEL: o Codex deve reescrever a 0076 a partir EXATAMENTE destes corpos,
--      só ADICIONANDO os branches (delivery reserva / deliver baixa / cancel libera),
--      sem reescrever lógica que já funciona.
--
-- Verificado no snapshot:
--   - register_partner_local_order vivo == migration 0067 (sem override posterior).
--   - cancel_partner_local_order vivo == migration 0075 (Parte B).
--   - quantity_reserved NÃO existe ainda em commerce.partner_stock_levels.
--   - Gate P1 OK: 0 entregas delivery em aberto. Número canônico (reconciliado):
--     entre os delivery NÃO-deletados existem só 3, todos status='cancelled'
--     (delivery_status: 2 delivered, 1 dispatched); o resto (11 no bruto) é soft-deleted.
--
-- ⚠️ Ao reescrever para a 0076, lembrar dos guards do adendo (seção 12 de
--    docs/PLANO_ESTOQUE_INTEGRADO_SECOES_2026-05-31.md):
--    P1 gate pré-deploy · P2 deliver só na transição · P3 status dono do banco ·
--    pickup desconta reserved · is_tracked=false/servico/on_hand NULL não reservam ·
--    liberar reserva com guard por estado (não deixar reserved < 0).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- register_partner_local_order (ATUAL — base da 0067)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION commerce.register_partner_local_order(p_environment text, p_unit_id uuid, p_customer_name text, p_customer_phone text, p_items jsonb, p_payment_method text, p_fulfillment_mode text, p_delivery_address text, p_actor_label text, p_idempotency_key text, p_source_tag text, p_discount_amount numeric DEFAULT 0, p_freight_amount numeric DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_order_id    UUID;
  v_existing    UUID;
  v_total       NUMERIC := 0;
  v_discount_order NUMERIC := GREATEST(COALESCE(p_discount_amount, 0), 0);
  v_freight     NUMERIC := GREATEST(COALESCE(p_freight_amount, 0), 0);
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

  SELECT id INTO v_existing
  FROM commerce.partner_orders
  WHERE idempotency_key = p_idempotency_key;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

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

      IF v_stock_row.is_tracked
         AND v_stock_row.quantity_on_hand IS NOT NULL
         AND v_stock_row.quantity_on_hand < v_qty THEN
        RAISE EXCEPTION 'Estoque insuficiente para "%": disponivel %, pedido %',
          v_stock_row.item_name, v_stock_row.quantity_on_hand, v_qty
          USING ERRCODE = '23514';
      END IF;

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

  v_total := GREATEST(v_total - v_discount_order + v_freight, 0);

  INSERT INTO commerce.partner_orders (
    environment, unit_id, customer_name, customer_phone,
    total_amount, discount_amount, freight_amount,
    status, payment_method, fulfillment_mode, delivery_address,
    source_tag, closed_by, closed_at, idempotency_key
  ) VALUES (
    p_environment, p_unit_id,
    NULLIF(trim(COALESCE(p_customer_name, '')), ''),
    NULLIF(trim(COALESCE(p_customer_phone, '')), ''),
    v_total, v_discount_order, v_freight,
    'confirmed', p_payment_method, p_fulfillment_mode, p_delivery_address,
    COALESCE(p_source_tag, 'walkin_balcao'), p_actor_label, now(), p_idempotency_key
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_stock_id := (v_item->>'partner_stock_id')::UUID;
    v_qty      := (v_item->>'quantity')::INTEGER;
    v_price    := (v_item->>'unit_price')::NUMERIC;
    v_discount := COALESCE((v_item->>'discount_amount')::NUMERIC, 0);

    IF v_stock_id IS NOT NULL THEN
      SELECT item_name, tire_size, brand, item_type INTO v_stock_row
      FROM commerce.partner_stock_levels
      WHERE id = v_stock_id;

      INSERT INTO commerce.partner_order_items (
        environment, order_id, partner_stock_id,
        item_name, tire_size, brand, item_type,
        quantity, unit_price, discount_amount
      ) VALUES (
        p_environment, v_order_id, v_stock_id,
        v_stock_row.item_name,
        v_stock_row.tire_size,
        v_stock_row.brand,
        v_stock_row.item_type,
        v_qty, v_price, v_discount
      );
    ELSE
      INSERT INTO commerce.partner_order_items (
        environment, order_id, partner_stock_id,
        item_name, tire_size, brand, item_type,
        quantity, unit_price, discount_amount
      ) VALUES (
        p_environment, v_order_id, NULL,
        COALESCE(v_item->>'item_name', 'Item livre'),
        NULL, NULL,
        NULLIF(v_item->>'item_type', ''),
        v_qty, v_price, v_discount
      );
    END IF;
  END LOOP;

  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, idempotency_key, payload_after
  ) VALUES (
    p_environment, 'partner_orders', 'commerce.partner_orders', v_order_id,
    'partner_order_created', p_actor_label, p_idempotency_key,
    jsonb_build_object(
      'total', v_total, 'discount_amount', v_discount_order,
      'freight_amount', v_freight, 'items', p_items, 'unit_id', p_unit_id
    )
  );

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
$function$;

-- ────────────────────────────────────────────────────────────
-- cancel_partner_local_order (ATUAL — base da 0075 Parte B)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION commerce.cancel_partner_local_order(p_order_id uuid, p_actor_label text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_environment   TEXT;
  v_unit_id       UUID;
  v_previous      TEXT;
  v_item          RECORD;
  v_receivable_id UUID;
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

      IF FOUND THEN
        INSERT INTO audit.events (
          environment, domain, entity_table, entity_id, event_type,
          actor_label, payload_after
        ) VALUES (
          v_environment, 'stock', 'commerce.partner_stock_levels', v_item.partner_stock_id,
          'stock_increment_sale_cancel', p_actor_label,
          jsonb_build_object('order_id', p_order_id, 'quantity', v_item.quantity, 'reason', p_reason)
        );
      END IF;
    END IF;
  END LOOP;

  UPDATE commerce.partner_orders
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_order_id;

  UPDATE finance.partner_receivables
  SET status = 'cancelled',
      deleted_at = now(),
      deleted_by = p_actor_label
  WHERE source_order_id = p_order_id
    AND environment = v_environment
    AND unit_id = v_unit_id
    AND status = 'open'
    AND deleted_at IS NULL
  RETURNING id INTO v_receivable_id;

  IF v_receivable_id IS NOT NULL THEN
    INSERT INTO audit.events (
      environment, domain, entity_table, entity_id, event_type,
      actor_label, payload_after
    ) VALUES (
      v_environment, 'partner_finance', 'finance.partner_receivables', v_receivable_id,
      'partner_receivable_cancelled_by_sale_cancel', p_actor_label,
      jsonb_build_object('source_order_id', p_order_id, 'reason', p_reason)
    );
  END IF;

  INSERT INTO audit.events (
    environment, domain, entity_table, entity_id, event_type,
    actor_label, payload_after
  ) VALUES (
    v_environment, 'partner_orders', 'commerce.partner_orders', p_order_id,
    'partner_order_cancelled', p_actor_label,
    jsonb_build_object(
      'reason', p_reason,
      'previous_status', v_previous,
      'cancelled_receivable_id', v_receivable_id
    )
  );
END;
$function$;
