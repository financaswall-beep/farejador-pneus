-- ============================================================
-- 0050_partner_finance_fixes_etapa1.sql
-- Etapa 1 dos consertos de conciliacao do financeiro do Portal Parceiro.
--
-- Resolve:
--   BUG #1: cancelar venda nao cancelava conta a receber auto-criada
--   BUG #2: categoria 'supplier' em payables virava 'maintenance' em expenses
--           (perde-se rastreio de "quanto gastei com fornecedor")
--
-- BUG #3 (dupla contagem no settlePayable) eh tratado em app-layer
-- nesta etapa (queries.ts), com FK formal vindo na Etapa 2.
--
-- Assinatura: Claude (Opus 4.7), 2026-05-24
-- ============================================================

-- ─────────────────────────────────────────────
-- BUG #2: nova categoria 'supplier_payment' em partner_expenses
-- ─────────────────────────────────────────────
ALTER TABLE finance.partner_expenses
  DROP CONSTRAINT IF EXISTS partner_expenses_category_check;

ALTER TABLE finance.partner_expenses
  ADD CONSTRAINT partner_expenses_category_check
  CHECK (category IN (
    'employee_payment',
    'rent',
    'utilities',
    'maintenance',
    'delivery',
    'tax',
    'supplier_payment',
    'other'
  ));

COMMENT ON CONSTRAINT partner_expenses_category_check ON finance.partner_expenses IS
  'Categorias de despesa do parceiro. supplier_payment foi adicionada na Etapa 1 dos consertos de conciliacao (2026-05-24) para evitar que pagamentos a fornecedor caissem como manutencao.';

-- ─────────────────────────────────────────────
-- BUG #1: cancel_partner_local_order agora cancela receivable vinculada
-- ─────────────────────────────────────────────
-- A venda "a receber" cria uma linha em finance.partner_receivables com
-- idempotency_key = 'order:' || order_id || ':receivable'. Cancelar a venda
-- precisa cancelar essa receivable em cascata. Sem isso, fica orfa em status
-- 'open' e pode ser "recebida" depois (registra entrada de dinheiro de venda
-- inexistente).
--
-- Estrategia: faz UPDATE condicional na receivable vinculada. Idempotente
-- (so toca quando status='open'). Audit event registrado para rastreabilidade.

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

  -- Cancela receivable auto-criada (se houver e ainda estiver em aberto).
  -- Ligacao via idempotency_key padronizada por queries.ts em 2026-05-24.
  UPDATE finance.partner_receivables
  SET status = 'cancelled',
      deleted_at = now(),
      deleted_by = p_actor_label
  WHERE idempotency_key = 'order:' || p_order_id || ':receivable'
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
      jsonb_build_object(
        'source_order_id', p_order_id,
        'reason', p_reason
      )
    );
  END IF;

  -- Audit da venda
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
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION commerce.cancel_partner_local_order IS
  'Cancela venda local do parceiro + restaura estoque + cancela conta a receber vinculada (se houver). Idempotente quanto a status (erro se ja cancelada).';
