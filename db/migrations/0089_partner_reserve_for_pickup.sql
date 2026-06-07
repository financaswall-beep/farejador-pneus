-- 0089 — Reserva na RETIRADA (pickup) para pedidos do bot da Rede.
--
-- Contexto (decisão Wallace, 2026-06-07): a retirada via bot passa a ser roteada
-- pra borracharia mais perto (mesmos critérios de proximidade da entrega) e o pneu
-- precisa ficar SEGURADO até o cliente retirar — sem vender/baixar antes da hora e
-- sem abrir recebível fantasma (o dinheiro entra quando ele retira no balcão).
--
-- Hoje commerce.register_partner_local_order amarra o efeito no estoque ao modo:
--   delivery → RESERVA (quantity_reserved, on_hand intacto)
--   pickup   → BAIXA FÍSICA (on_hand -= qty)  [venda de balcão imediata]
--
-- A baixa física é certa pro BALCÃO (cliente leva na hora), mas errada pra um pedido
-- de retirada feito pelo bot (cliente vai buscar depois): aí queremos RESERVAR.
--
-- Mudança ADITIVA e segura:
--   + parâmetro p_reserve_for_pickup boolean DEFAULT false (ÚLTIMO, com default).
--     - false (padrão) → comportamento BYTE-IDÊNTICO ao de hoje. Balcão (13 args) e
--       entrega do bot continuam intactos.
--     - true + modo=pickup → RESERVA em vez de baixar (segura o pneu até retirar).
--
-- Sem dependentes no banco (information_schema.routine_routine_usage = vazio).
-- DROP+CREATE porque adicionar parâmetro muda a assinatura.

DROP FUNCTION IF EXISTS commerce.register_partner_local_order(
  text, uuid, text, text, jsonb, text, text, text, text, text, text, numeric, numeric);

CREATE OR REPLACE FUNCTION commerce.register_partner_local_order(
  p_environment text,
  p_unit_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_items jsonb,
  p_payment_method text,
  p_fulfillment_mode text,
  p_delivery_address text,
  p_actor_label text,
  p_idempotency_key text,
  p_source_tag text,
  p_discount_amount numeric DEFAULT 0,
  p_freight_amount numeric DEFAULT 0,
  p_reserve_for_pickup boolean DEFAULT false
)
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
  -- Reserva quando é entrega OU quando a retirada pediu explicitamente pra reservar
  -- (pedido de retirada do bot). Senão, baixa física (balcão de hoje).
  v_reserve     BOOLEAN := (p_fulfillment_mode = 'delivery') OR COALESCE(p_reserve_for_pickup, false);
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

        IF v_reserve THEN
          -- entrega OU retirada-reservada: reserva (on_hand intacto)
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
          -- retirada-venda (balcão) / outro: baixa física (como hoje)
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

  -- Evento de movimento: 'stock_reserved' quando reservou (entrega ou retirada-reservada),
  -- 'stock_decrement_sale' quando baixou (balcão).
  IF jsonb_array_length(v_moves) > 0 THEN
    INSERT INTO audit.events (
      environment, domain, entity_table, entity_id, event_type,
      actor_label, payload_after
    ) VALUES (
      p_environment, 'stock', 'commerce.partner_stock_levels', v_order_id,
      CASE WHEN v_reserve THEN 'stock_reserved' ELSE 'stock_decrement_sale' END,
      p_actor_label,
      jsonb_build_object(
        'order_id', v_order_id, 'fulfillment_mode', p_fulfillment_mode,
        'reserved_for_pickup', COALESCE(p_reserve_for_pickup, false), 'moves', v_moves)
    );
  END IF;

  RETURN v_order_id;
END;
$function$;
