-- ============================================================
-- 0051_partner_finance_fks_etapa2.sql
-- Etapa 2 dos consertos de conciliacao do financeiro do Portal Parceiro.
--
-- Substitui a gambiarra de "ligacao por idempotency_key (string)" por
-- foreign keys formais entre as entidades:
--
--   finance.partner_receivables.source_order_id   -> commerce.partner_orders(id)
--   finance.partner_payables.source_purchase_id   -> commerce.partner_purchases(id)
--   finance.partner_expenses.source_payable_id    -> finance.partner_payables(id)
--
-- Beneficios:
--   - cancelar venda cancela receivable por FK (mais robusto que string match)
--   - relatorios podem JOINar direto
--   - UNIQUE WHERE NOT NULL impede duplicidade auto
--   - validacao de environment via trigger env_match
--
-- Backfill:
--   - source_order_id em partner_receivables: extrai UUID de
--     idempotency_key padrao 'order:<UUID>:receivable'
--   - source_payable_id em partner_expenses: extrai UUID de
--     idempotency_key padrao 'payable:<UUID>:expense'
--   - source_purchase_id em partner_payables: nada a backfillar
--     (compra-a-prazo so chega na Etapa 3)
--
-- Recria commerce.cancel_partner_local_order para usar source_order_id.
--
-- Assinatura: Claude (Opus 4.7), 2026-05-24
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. Novas colunas FK
-- ─────────────────────────────────────────────
ALTER TABLE finance.partner_receivables
  ADD COLUMN IF NOT EXISTS source_order_id UUID;

ALTER TABLE finance.partner_payables
  ADD COLUMN IF NOT EXISTS source_purchase_id UUID;

ALTER TABLE finance.partner_expenses
  ADD COLUMN IF NOT EXISTS source_payable_id UUID;

-- ─────────────────────────────────────────────
-- 2. Backfill antes de criar as FKs
--    (se houver lixo em idempotency_key que nao casa, fica NULL)
-- ─────────────────────────────────────────────
UPDATE finance.partner_receivables
SET source_order_id = SUBSTRING(idempotency_key FROM 'order:([0-9a-fA-F-]{36}):receivable')::uuid
WHERE source_order_id IS NULL
  AND idempotency_key ~ '^order:[0-9a-fA-F-]{36}:receivable$';

UPDATE finance.partner_expenses
SET source_payable_id = SUBSTRING(idempotency_key FROM 'payable:([0-9a-fA-F-]{36}):expense')::uuid
WHERE source_payable_id IS NULL
  AND idempotency_key ~ '^payable:[0-9a-fA-F-]{36}:expense$';

-- Sanity: imprime alerta se sobrou linha com padrao reconhecido mas FK nao
-- preenchida (apontaria pra bug no regex acima).
DO $$
DECLARE
  v_orphan_receivables INT;
  v_orphan_expenses    INT;
BEGIN
  SELECT count(*) INTO v_orphan_receivables
  FROM finance.partner_receivables
  WHERE source_order_id IS NULL
    AND idempotency_key LIKE 'order:%:receivable';

  SELECT count(*) INTO v_orphan_expenses
  FROM finance.partner_expenses
  WHERE source_payable_id IS NULL
    AND idempotency_key LIKE 'payable:%:expense';

  IF v_orphan_receivables > 0 THEN
    RAISE WARNING 'Etapa 2: % receivables com idempotency_key tipo order: ficaram sem source_order_id (regex falhou ou UUID invalido)', v_orphan_receivables;
  END IF;
  IF v_orphan_expenses > 0 THEN
    RAISE WARNING 'Etapa 2: % expenses com idempotency_key tipo payable: ficaram sem source_payable_id', v_orphan_expenses;
  END IF;
END $$;

-- ─────────────────────────────────────────────
-- 3. FK constraints (ON DELETE SET NULL: cancelamento logico preserva historico)
-- ─────────────────────────────────────────────
ALTER TABLE finance.partner_receivables
  DROP CONSTRAINT IF EXISTS partner_receivables_source_order_fk;
ALTER TABLE finance.partner_receivables
  ADD CONSTRAINT partner_receivables_source_order_fk
  FOREIGN KEY (source_order_id) REFERENCES commerce.partner_orders(id) ON DELETE SET NULL;

ALTER TABLE finance.partner_payables
  DROP CONSTRAINT IF EXISTS partner_payables_source_purchase_fk;
ALTER TABLE finance.partner_payables
  ADD CONSTRAINT partner_payables_source_purchase_fk
  FOREIGN KEY (source_purchase_id) REFERENCES commerce.partner_purchases(id) ON DELETE SET NULL;

ALTER TABLE finance.partner_expenses
  DROP CONSTRAINT IF EXISTS partner_expenses_source_payable_fk;
ALTER TABLE finance.partner_expenses
  ADD CONSTRAINT partner_expenses_source_payable_fk
  FOREIGN KEY (source_payable_id) REFERENCES finance.partner_payables(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────
-- 4. UNIQUE parcial: cada venda gera no maximo 1 receivable auto,
--    cada compra gera no maximo 1 payable auto,
--    cada payable gera no maximo 1 expense auto.
-- ─────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS partner_receivables_source_order_uniq
  ON finance.partner_receivables(source_order_id)
  WHERE source_order_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS partner_payables_source_purchase_uniq
  ON finance.partner_payables(source_purchase_id)
  WHERE source_purchase_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS partner_expenses_source_payable_uniq
  ON finance.partner_expenses(source_payable_id)
  WHERE source_payable_id IS NOT NULL AND deleted_at IS NULL;

-- Indices nao-unicos pra JOIN reverso eficiente
CREATE INDEX IF NOT EXISTS partner_receivables_source_order_idx
  ON finance.partner_receivables(source_order_id)
  WHERE source_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_payables_source_purchase_idx
  ON finance.partner_payables(source_purchase_id)
  WHERE source_purchase_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_expenses_source_payable_idx
  ON finance.partner_expenses(source_payable_id)
  WHERE source_payable_id IS NOT NULL;

-- ─────────────────────────────────────────────
-- 5. env_match triggers nas novas FKs (defesa em profundidade)
-- ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS env_match_partner_receivables_source_order ON finance.partner_receivables;
CREATE TRIGGER env_match_partner_receivables_source_order
  BEFORE INSERT OR UPDATE OF source_order_id ON finance.partner_receivables
  FOR EACH ROW
  WHEN (NEW.source_order_id IS NOT NULL)
  EXECUTE FUNCTION ops.validate_env_match('commerce', 'partner_orders', 'source_order_id');

DROP TRIGGER IF EXISTS env_match_partner_payables_source_purchase ON finance.partner_payables;
CREATE TRIGGER env_match_partner_payables_source_purchase
  BEFORE INSERT OR UPDATE OF source_purchase_id ON finance.partner_payables
  FOR EACH ROW
  WHEN (NEW.source_purchase_id IS NOT NULL)
  EXECUTE FUNCTION ops.validate_env_match('commerce', 'partner_purchases', 'source_purchase_id');

DROP TRIGGER IF EXISTS env_match_partner_expenses_source_payable ON finance.partner_expenses;
CREATE TRIGGER env_match_partner_expenses_source_payable
  BEFORE INSERT OR UPDATE OF source_payable_id ON finance.partner_expenses
  FOR EACH ROW
  WHEN (NEW.source_payable_id IS NOT NULL)
  EXECUTE FUNCTION ops.validate_env_match('finance', 'partner_payables', 'source_payable_id');

-- ─────────────────────────────────────────────
-- 6. Recria cancel_partner_local_order usando FK source_order_id
--    (substitui o match por idempotency_key da Etapa 1)
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

  -- Cancela receivable vinculada via FK source_order_id (em vez de idempotency_key)
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
  'Cancela venda local do parceiro + restaura estoque + cancela receivable vinculada via FK source_order_id. Idempotente quanto a status (erro se ja cancelada).';

-- ─────────────────────────────────────────────
-- 7. Comentarios nas novas colunas
-- ─────────────────────────────────────────────
COMMENT ON COLUMN finance.partner_receivables.source_order_id IS
  'FK opcional para commerce.partner_orders. Preenchida quando a receivable nasceu de uma venda "a receber". Cancelamento da venda cancela essa receivable em cascade.';

COMMENT ON COLUMN finance.partner_payables.source_purchase_id IS
  'FK opcional para commerce.partner_purchases. Preenchida quando o payable nasceu de uma compra a prazo (a partir da Etapa 3).';

COMMENT ON COLUMN finance.partner_expenses.source_payable_id IS
  'FK opcional para finance.partner_payables. Preenchida quando a despesa foi auto-criada ao marcar o payable como pago. Permite detectar duplicidade.';
