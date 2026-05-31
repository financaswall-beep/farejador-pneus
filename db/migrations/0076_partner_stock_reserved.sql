-- ============================================================
-- 0076_partner_stock_reserved.sql  — APLICADA EM PROD (2026-05-31)
--
-- Estoque com estado RESERVADO integrado à entrega COD.
-- Base fiel: docs/SNAPSHOT_FUNCOES_PRE_0076_2026-05-31.sql (corpos de prod).
-- Contrato: seção 12 de docs/PLANO_ESTOQUE_INTEGRADO_SECOES_2026-05-31.md.
--
-- Conceitos:
--   quantity_on_hand   = físico (só cai quando o pneu SAI de fato).
--   quantity_reserved  = comprometido com entregas em aberto.
--   disponível         = quantity_on_hand - quantity_reserved.
--
-- Guards do adendo aplicados aqui:
--   P2  deliver só baixa na TRANSIÇÃO (erro se já 'delivered').
--   P3  TODO update de saldo calcula status via commerce.partner_stock_status (helper).
--   §12.3.1 checagem de saldo é contra DISPONÍVEL (vale p/ pickup e delivery).
--   §12.3.2 is_tracked=false / serviço NUNCA reservam (e deliver pula sem erro).
--   §12.3.3 on_hand IS NULL (unknown) NÃO reserva nem baixa (simétrico com hoje).
--   §12.3.4 cancel libera reserva com piso (GREATEST 0) + guard reserved>0 p/ não
--           violar CHECK, não travar a ordem, e não gerar evento enganoso.
--   §12.3.5 mantém FOR UPDATE nas linhas de estoque.
--
-- Correções pós-review Codex (2026-05-31):
--   #1 CHECK de stock_status recriado p/ aceitar 'reserved' (parte 1b).
--   #2 deliver FALHA ALTO se quantity_reserved < qty (NÃO usa GREATEST p/ mascarar).
--   #3 backend deve chamar deliver ANTES do UPDATE delivery_status='delivered' (ver IMPL).
--   #4 cancel só emite stock_reservation_released quando havia reserva real (reserved>0).
--
-- Aditiva e segura: coluna com DEFAULT 0; Gate P1 = 0 (sem delivery aberta).
-- Assinatura: Claude (Opus 4.8) + Codex, 2026-05-31. Aplicada em prod por Codex.
-- ============================================================

-- ── 1. Coluna + CHECK ───────────────────────────────────────────────────────
ALTER TABLE commerce.partner_stock_levels
  ADD COLUMN IF NOT EXISTS quantity_reserved integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN commerce.partner_stock_levels.quantity_reserved IS
  'Unidades comprometidas com entregas em aberto (delivery/COD). '
  'disponível = quantity_on_hand - quantity_reserved. Baixa física só na entrega.';

ALTER TABLE commerce.partner_stock_levels
  DROP CONSTRAINT IF EXISTS partner_stock_levels_reserved_check;
ALTER TABLE commerce.partner_stock_levels
  ADD CONSTRAINT partner_stock_levels_reserved_check
  CHECK (
    quantity_reserved >= 0
    AND (quantity_on_hand IS NULL OR quantity_on_hand >= quantity_reserved)
  );

-- ── 1b. CHECK de stock_status: liberar o novo estado 'reserved' (BLOQUEIO Codex #1) ─
-- Original (0035): unknown | in_stock | low_stock | out_of_stock | not_tracked.
-- Sem isto, o helper retornando 'reserved' viola o CHECK e barra o 1º pedido delivery.
ALTER TABLE commerce.partner_stock_levels
  DROP CONSTRAINT IF EXISTS partner_stock_levels_stock_status_check;
ALTER TABLE commerce.partner_stock_levels
  ADD CONSTRAINT partner_stock_levels_stock_status_check
  CHECK (stock_status = ANY (ARRAY[
    'unknown'::text, 'in_stock'::text, 'low_stock'::text,
    'out_of_stock'::text, 'not_tracked'::text, 'reserved'::text
  ]));

-- ── 2. Helper de status (fonte ÚNICA — P3) ──────────────────────────────────
-- Status alvo:
--   not_tracked · unknown (on_hand null) · out_of_stock (on_hand<=0) ·
--   reserved (on_hand>0 mas disponível<=0) · low_stock (disponível<=mínimo) · in_stock
CREATE OR REPLACE FUNCTION commerce.partner_stock_status(
  p_on_hand    integer,
  p_reserved   integer,
  p_minimum    integer,
  p_is_tracked boolean
) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN NOT p_is_tracked                                            THEN 'not_tracked'
    WHEN p_on_hand IS NULL                                           THEN 'unknown'
    WHEN p_on_hand <= 0                                              THEN 'out_of_stock'
    WHEN (p_on_hand - COALESCE(p_reserved, 0)) <= 0                  THEN 'reserved'
    WHEN p_minimum IS NOT NULL
         AND (p_on_hand - COALESCE(p_reserved, 0)) <= p_minimum      THEN 'low_stock'
    ELSE 'in_stock'
  END
$$;

COMMENT ON FUNCTION commerce.partner_stock_status(integer, integer, integer, boolean) IS
  'Status derivado do estoque considerando reservado. Fonte única — todo UPDATE de '
  'saldo deve chamar este helper em vez de recalcular o CASE inline.';

-- ── 3. register_partner_local_order (FIEL ao 0067 + branch por modalidade) ───
-- delivery → quantity_reserved += qty (on_hand intacto), evento 'stock_reserved'.
-- pickup/outro → quantity_on_hand -= qty (como hoje), evento 'stock_decrement_sale'.
-- Checagem de saldo: contra DISPONÍVEL (on_hand - reserved).
CREATE OR REPLACE FUNCTION commerce.register_partner_local_order(
  p_environment text, p_unit_id uuid, p_customer_name text, p_customer_phone text,
  p_items jsonb, p_payment_method text, p_fulfillment_mode text, p_delivery_address text,
  p_actor_label text, p_idempotency_key text, p_source_tag text,
  p_discount_amount numeric DEFAULT 0, p_freight_amount numeric DEFAULT 0)
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
  v_new_reserved INTEGER;
  v_new_status  TEXT;
  v_is_delivery BOOLEAN := (p_fulfillment_mode = 'delivery');
  v_available   INTEGER;
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
      SELECT id, item_name, tire_size, brand, quantity_on_hand, quantity_reserved,
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

      -- Checagem de saldo contra DISPONÍVEL (vale p/ pickup e delivery).
      IF v_stock_row.is_tracked
         AND v_stock_row.quantity_on_hand IS NOT NULL THEN
        v_available := v_stock_row.quantity_on_hand - COALESCE(v_stock_row.quantity_reserved, 0);
        IF v_available < v_qty THEN
          RAISE EXCEPTION 'Estoque insuficiente para "%": disponivel %, pedido %',
            v_stock_row.item_name, v_available, v_qty
            USING ERRCODE = '23514';
        END IF;

        IF v_is_delivery THEN
          -- delivery: reserva (on_hand intacto)
          UPDATE commerce.partner_stock_levels
          SET quantity_reserved = COALESCE(quantity_reserved, 0) + v_qty,
              stock_status = commerce.partner_stock_status(
                quantity_on_hand, COALESCE(quantity_reserved, 0) + v_qty,
                minimum_quantity, is_tracked),
              updated_at = now(), updated_by = p_actor_label
          WHERE id = v_stock_id
          RETURNING quantity_on_hand, quantity_reserved, stock_status
            INTO v_new_qty, v_new_reserved, v_new_status;

          v_moves := v_moves || jsonb_build_object(
            'stock_id', v_stock_id, 'item_name', v_stock_row.item_name,
            'reserved_delta', v_qty, 'new_qty', v_new_qty,
            'new_reserved', v_new_reserved, 'new_status', v_new_status);
        ELSE
          -- pickup/outro: baixa física (como hoje)
          UPDATE commerce.partner_stock_levels
          SET quantity_on_hand = quantity_on_hand - v_qty,
              stock_status = commerce.partner_stock_status(
                quantity_on_hand - v_qty, COALESCE(quantity_reserved, 0),
                minimum_quantity, is_tracked),
              updated_at = now(), updated_by = p_actor_label
          WHERE id = v_stock_id
          RETURNING quantity_on_hand, quantity_reserved, stock_status
            INTO v_new_qty, v_new_reserved, v_new_status;

          v_moves := v_moves || jsonb_build_object(
            'stock_id', v_stock_id, 'item_name', v_stock_row.item_name,
            'delta', -v_qty, 'new_qty', v_new_qty,
            'new_reserved', v_new_reserved, 'new_status', v_new_status);
        END IF;
      END IF;
      -- is_tracked=false / serviço / on_hand NULL: não reserva nem baixa.
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
        v_stock_row.item_name, v_stock_row.tire_size, v_stock_row.brand,
        v_stock_row.item_type, v_qty, v_price, v_discount
      );
    ELSE
      INSERT INTO commerce.partner_order_items (
        environment, order_id, partner_stock_id,
        item_name, tire_size, brand, item_type,
        quantity, unit_price, discount_amount
      ) VALUES (
        p_environment, v_order_id, NULL,
        COALESCE(v_item->>'item_name', 'Item livre'),
        NULL, NULL, NULLIF(v_item->>'item_type', ''),
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
      'freight_amount', v_freight, 'items', p_items, 'unit_id', p_unit_id)
  );

  -- Evento de movimento: 'stock_reserved' p/ delivery, 'stock_decrement_sale' p/ pickup.
  IF jsonb_array_length(v_moves) > 0 THEN
    INSERT INTO audit.events (
      environment, domain, entity_table, entity_id, event_type,
      actor_label, payload_after
    ) VALUES (
      p_environment, 'stock', 'commerce.partner_stock_levels', v_order_id,
      CASE WHEN v_is_delivery THEN 'stock_reserved' ELSE 'stock_decrement_sale' END,
      p_actor_label,
      jsonb_build_object('order_id', v_order_id, 'fulfillment_mode', p_fulfillment_mode, 'moves', v_moves)
    );
  END IF;

  RETURN v_order_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION commerce.register_partner_local_order(
  TEXT, UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC
) TO farejador_partner_app;

-- ── 4. deliver_partner_local_order (NOVA) ───────────────────────────────────
-- Converte reserva em baixa física na ENTREGA. P2: só na transição (erro se delivered).
CREATE OR REPLACE FUNCTION commerce.deliver_partner_local_order(
  p_order_id uuid, p_actor_label text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_environment     TEXT;
  v_unit_id         UUID;
  v_fulfillment     TEXT;
  v_delivery_status TEXT;
  v_status          TEXT;
  v_item            RECORD;
  v_stock           RECORD;
BEGIN
  SELECT environment, unit_id, fulfillment_mode, delivery_status, status
    INTO v_environment, v_unit_id, v_fulfillment, v_delivery_status, v_status
  FROM commerce.partner_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_environment IS NULL THEN
    RAISE EXCEPTION 'Pedido nao encontrado: %', p_order_id;
  END IF;
  IF v_fulfillment <> 'delivery' THEN
    RAISE EXCEPTION 'deliver_partner_local_order so vale para delivery (pedido %)', p_order_id;
  END IF;
  -- P2: idempotência por ESTADO. Só baixa na transição para delivered.
  IF v_delivery_status = 'delivered' THEN
    RAISE EXCEPTION 'Entrega ja finalizada: %', p_order_id USING ERRCODE = '23514';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'Pedido cancelado nao pode ser entregue: %', p_order_id;
  END IF;

  FOR v_item IN
    SELECT partner_stock_id, quantity
    FROM commerce.partner_order_items
    WHERE order_id = p_order_id AND environment = v_environment
  LOOP
    IF v_item.partner_stock_id IS NOT NULL THEN
      -- Trava a linha e lê o estado atual ANTES de decidir (BLOQUEIO Codex #2).
      SELECT id, item_name, quantity_on_hand, quantity_reserved, minimum_quantity, is_tracked
        INTO v_stock
      FROM commerce.partner_stock_levels
      WHERE id = v_item.partner_stock_id
        AND environment = v_environment
        AND unit_id = v_unit_id
        AND deleted_at IS NULL
      FOR UPDATE;

      -- Item que NÃO reservou na criação (não rastreado, ou saldo unknown) é pulado
      -- sem erro — simétrico com register, que também não reservou.
      IF FOUND AND v_stock.is_tracked AND v_stock.quantity_on_hand IS NOT NULL THEN
        -- Entrega NÃO mascara reserva insuficiente: falha alto (Codex #2).
        IF COALESCE(v_stock.quantity_reserved, 0) < v_item.quantity THEN
          RAISE EXCEPTION
            'Reserva insuficiente na entrega de "%": reservado %, item %',
            v_stock.item_name, COALESCE(v_stock.quantity_reserved, 0), v_item.quantity
            USING ERRCODE = '23514';
        END IF;

        UPDATE commerce.partner_stock_levels
        SET quantity_on_hand  = quantity_on_hand - v_item.quantity,
            quantity_reserved = quantity_reserved - v_item.quantity,
            stock_status = commerce.partner_stock_status(
              quantity_on_hand - v_item.quantity,
              quantity_reserved - v_item.quantity,
              minimum_quantity, is_tracked),
            updated_at = now(), updated_by = p_actor_label
        WHERE id = v_item.partner_stock_id;

        INSERT INTO audit.events (
          environment, domain, entity_table, entity_id, event_type,
          actor_label, payload_after
        ) VALUES (
          v_environment, 'stock', 'commerce.partner_stock_levels', v_item.partner_stock_id,
          'stock_decrement_sale', p_actor_label,
          jsonb_build_object('order_id', p_order_id, 'quantity', v_item.quantity,
                             'context', 'delivery_delivered')
        );
      END IF;
    END IF;
  END LOOP;
END;
$function$;

GRANT EXECUTE ON FUNCTION commerce.deliver_partner_local_order(uuid, text)
  TO farejador_partner_app;

-- ── 5. cancel_partner_local_order (FIEL ao 0075 + branch por estado) ─────────
-- delivery pendente/a caminho → libera reserva (evento stock_reservation_released).
-- senão (pickup, ou delivery já entregue) → restaura físico (stock_increment_sale_cancel).
CREATE OR REPLACE FUNCTION commerce.cancel_partner_local_order(
  p_order_id uuid, p_actor_label text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_environment     TEXT;
  v_unit_id         UUID;
  v_previous        TEXT;
  v_fulfillment     TEXT;
  v_delivery_status TEXT;
  v_release_reserve BOOLEAN;
  v_item            RECORD;
  v_receivable_id   UUID;
BEGIN
  SELECT environment, unit_id, status, fulfillment_mode, delivery_status
    INTO v_environment, v_unit_id, v_previous, v_fulfillment, v_delivery_status
  FROM commerce.partner_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_previous IS NULL THEN
    RAISE EXCEPTION 'Venda nao encontrada: %', p_order_id;
  END IF;
  IF v_previous = 'cancelled' THEN
    RAISE EXCEPTION 'Venda ja cancelada: %', p_order_id;
  END IF;

  -- delivery ainda não entregue: estava RESERVADO → libera reserva.
  -- pickup, ou delivery já 'delivered' (baixado): restaura físico.
  v_release_reserve := (v_fulfillment = 'delivery'
                        AND v_delivery_status IN ('pending', 'dispatched'));

  FOR v_item IN
    SELECT partner_stock_id, quantity
    FROM commerce.partner_order_items
    WHERE order_id = p_order_id AND environment = v_environment
  LOOP
    IF v_item.partner_stock_id IS NOT NULL THEN
      IF v_release_reserve THEN
        -- GREATEST mantém o piso (não viola CHECK / não trava a ordem). O guard
        -- quantity_reserved > 0 no WHERE evita evento enganoso quando não havia
        -- reserva real para liberar (Codex #4).
        UPDATE commerce.partner_stock_levels
        SET quantity_reserved = GREATEST(COALESCE(quantity_reserved, 0) - v_item.quantity, 0),
            stock_status = commerce.partner_stock_status(
              quantity_on_hand,
              GREATEST(COALESCE(quantity_reserved, 0) - v_item.quantity, 0),
              minimum_quantity, is_tracked),
            updated_at = now(), updated_by = p_actor_label
        WHERE id = v_item.partner_stock_id
          AND environment = v_environment AND unit_id = v_unit_id
          AND deleted_at IS NULL AND is_tracked
          AND COALESCE(quantity_reserved, 0) > 0;

        IF FOUND THEN
          INSERT INTO audit.events (
            environment, domain, entity_table, entity_id, event_type,
            actor_label, payload_after
          ) VALUES (
            v_environment, 'stock', 'commerce.partner_stock_levels', v_item.partner_stock_id,
            'stock_reservation_released', p_actor_label,
            jsonb_build_object('order_id', p_order_id, 'quantity', v_item.quantity, 'reason', p_reason)
          );
        END IF;
      ELSE
        UPDATE commerce.partner_stock_levels
        SET quantity_on_hand = COALESCE(quantity_on_hand, 0) + v_item.quantity,
            stock_status = commerce.partner_stock_status(
              COALESCE(quantity_on_hand, 0) + v_item.quantity,
              COALESCE(quantity_reserved, 0),
              minimum_quantity, is_tracked),
            updated_at = now(), updated_by = p_actor_label
        WHERE id = v_item.partner_stock_id
          AND environment = v_environment AND unit_id = v_unit_id
          AND deleted_at IS NULL AND is_tracked;

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
    END IF;
  END LOOP;

  UPDATE commerce.partner_orders
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_order_id;

  UPDATE finance.partner_receivables
  SET status = 'cancelled', deleted_at = now(), deleted_by = p_actor_label
  WHERE source_order_id = p_order_id
    AND environment = v_environment AND unit_id = v_unit_id
    AND status = 'open' AND deleted_at IS NULL
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
    jsonb_build_object('reason', p_reason, 'previous_status', v_previous,
                       'cancelled_receivable_id', v_receivable_id)
  );
END;
$function$;

-- ── 6. Normalização: recalcula stock_status de todas as linhas pelo helper ──
-- Seguro: reserved=0 em todas as linhas existentes (Gate P1), então o status não muda
-- de valor — só garante que a fonte passou a ser o helper.
UPDATE commerce.partner_stock_levels
SET stock_status = commerce.partner_stock_status(
      quantity_on_hand, quantity_reserved, minimum_quantity, is_tracked)
WHERE deleted_at IS NULL;
