-- ============================================================
-- 0131_satisfaction_matriz_order.sql
-- PESQUISA DE SATISFAÇÃO — cobrir a ENTREGA da MATRIZ (não só o parceiro).
--
-- Contexto: a 0105 amarrou a pesquisa em partner_order_id (pedido do PARCEIRO).
-- Mas a matriz virou LOJA (06-29) e hoje é quem MAIS entrega — e o pedido dela
-- vive em commerce.orders (unit slug='main'), SEM partner_order_id. Resultado:
-- entrega da matriz nunca gerava pesquisa. Esta migration abre o segundo trilho.
--
-- Desenho: coluna order_id (→ commerce.orders) espelhando partner_order_id, com
-- índice único PARCIAL próprio (1 pesquisa por pedido da matriz). O disparo da
-- matriz preenche order_id e deixa partner_order_id NULL; o do parceiro segue
-- igual. A captura da nota (por conversation_id) e o expirador NÃO mudam.
--
-- Regra de ouro: order_id é pedido da MATRIZ (main) — o parceiro NUNCA vê (fora
-- do GRANT por coluna da 0105 e da view partner_satisfaction). Provado abaixo.
--
-- 100% ADITIVA e DORMENTE (mesma flag SATISFACTION_SURVEY, ainda default OFF).
-- Rollback no fim (comentado).
-- Assinatura: Orquestrador (Claude Opus 4.8) — banco, 2026-07-10
-- ============================================================

ALTER TABLE commerce.satisfaction_surveys
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES commerce.orders(id);

COMMENT ON COLUMN commerce.satisfaction_surveys.order_id IS
  '0131: pedido da MATRIZ (commerce.orders, unit main) que disparou a pesquisa — espelho de partner_order_id pro trilho da matriz. Parceiro NÃO lê (fora do grant por coluna + da view partner_satisfaction).';

-- Anti-duplicata da matriz: 1 pesquisa por pedido (parcial — só quando há order_id).
CREATE UNIQUE INDEX IF NOT EXISTS satisfaction_surveys_matriz_order_uniq
  ON commerce.satisfaction_surveys(order_id)
  WHERE order_id IS NOT NULL;

-- ─────────────────────────────────────────────
-- VALIDAÇÃO PÓS-MIGRATION (padrão 0105/0130)
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_col   BOOLEAN;
  v_idx   BOOLEAN;
  v_read  BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='commerce' AND table_name='satisfaction_surveys'
                    AND column_name='order_id') INTO v_col;
  IF NOT v_col THEN RAISE EXCEPTION '0131 falhou: coluna order_id nao existe'; END IF;

  SELECT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='commerce' AND indexname='satisfaction_surveys_matriz_order_uniq') INTO v_idx;
  IF NOT v_idx THEN RAISE EXCEPTION '0131 falhou: indice unico da matriz nao existe'; END IF;

  -- Regra de ouro: parceiro NÃO lê o pedido da matriz (grant por coluna da 0105).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    SELECT has_column_privilege('farejador_partner_app', 'commerce.satisfaction_surveys',
                                'order_id', 'SELECT') INTO v_read;
    IF v_read THEN
      RAISE EXCEPTION '0131 falhou: farejador_partner_app NAO deveria ler order_id (pedido da matriz)';
    END IF;
  END IF;

  RAISE NOTICE '0131 OK: order_id + indice unico parcial; parceiro sem leitura do pedido da matriz.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP INDEX IF EXISTS commerce.satisfaction_surveys_matriz_order_uniq;
--   ALTER TABLE commerce.satisfaction_surveys DROP COLUMN IF EXISTS order_id;
-- ============================================================
