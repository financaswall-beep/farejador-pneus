-- ============================================================
-- 0080_partner_cancel_reverts_received_receivable.sql
--
-- FURO DE CAIXA: cancelar uma venda COD que já foi ENTREGUE (conta a
-- receber 'received', dinheiro já no caixa do mês) NÃO estornava a
-- conta a receber — o cancel_partner_local_order só mexia em conta
-- 'open'. Resultado: estoque voltava, mas o caixa do mês continuava
-- contando a venda cancelada (network.partner_unit_summary.cash_in_month
-- soma partner_receivables_effective com status='received').
--
-- Fix: o estorno passa a pegar status IN ('open','received'). Cancelar
-- a venda reverte o dinheiro também (a venda deixou de existir).
-- Recria commerce.cancel_partner_local_order — única mudança é o
-- predicado do UPDATE da conta a receber (o resto é idêntico à versão
-- em prod, base 0069/0076). Aditiva: não altera dados existentes.
-- (O backfill das contas que já ficaram 'received' órfãs é feito à parte.)
-- ============================================================

CREATE OR REPLACE FUNCTION commerce.cancel_partner_local_order(p_order_id uuid, p_actor_label text, p_reason text)
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

  -- Estorna a conta a receber vinculada. ANTES só pegava 'open' — agora
  -- também 'received' (COD entregue): cancelar a venda tira o dinheiro do
  -- caixa, senão a venda cancelada continua contando.
  UPDATE finance.partner_receivables
  SET status = 'cancelled', deleted_at = now(), deleted_by = p_actor_label
  WHERE source_order_id = p_order_id
    AND environment = v_environment AND unit_id = v_unit_id
    AND status IN ('open', 'received') AND deleted_at IS NULL
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
