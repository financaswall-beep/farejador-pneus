-- 0075: Posição do pneu em coluna própria + auditoria de estorno por item
--
-- Parte A — separar Posição de supplier_name (correção de dívida 🔴 da auditoria
-- 2026-05-31). Antes o select "Posição" do modal de estoque gravava
-- Traseiro/Dianteiro em commerce.partner_stock_levels.supplier_name, a MESMA
-- coluna usada pelo fornecedor (Compras) e lida como origem 2W/Porta. Conflito:
-- editar a posição apagava fornecedor/origem. Agora a posição tem coluna própria.
--
-- Aditivo e seguro: coluna nulável, sem default. Backfill afeta só linhas com a
-- posição mal-guardada. Idempotente.
--
-- Parte B — auditoria por item no cancelamento de venda (🟡). A função
-- commerce.cancel_partner_local_order já devolve o estoque corretamente, mas não
-- registrava evento por item. Reescrita FIEL ao corpo atual + INSERT de auditoria
-- 'stock_increment_sale_cancel' dentro do loop. Nenhuma mudança na lógica de saldo.

-- ── Parte A ───────────────────────────────────────────────────────────────────
ALTER TABLE commerce.partner_stock_levels
  ADD COLUMN IF NOT EXISTS tire_position text;

COMMENT ON COLUMN commerce.partner_stock_levels.tire_position IS
  'Posição do pneu: Traseiro | Dianteiro (NULL = n/a). Antes vivia (errado) em supplier_name.';

-- Backfill 1: posição que estava literalmente em supplier_name.
UPDATE commerce.partner_stock_levels
   SET tire_position = supplier_name, supplier_name = NULL
 WHERE supplier_name IN ('Traseiro', 'Dianteiro') AND tire_position IS NULL;

-- Backfill 2: legado onde item_name codifica a posição (ex.: item_name='Traseiro').
UPDATE commerce.partner_stock_levels
   SET tire_position = initcap(lower(item_name))
 WHERE item_type = 'pneu' AND tire_position IS NULL
   AND lower(item_name) IN ('traseiro', 'dianteiro');

-- ── Parte B ───────────────────────────────────────────────────────────────────
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

      -- Auditoria por item do estorno de saldo (adicionado em 0075).
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
