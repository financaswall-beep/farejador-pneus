-- ============================================================
-- 0116_wholesale_cancel_trail.sql
-- ATACADO — CANCELAR VENDA: a trilha do cancelamento.
--
-- Contexto (negócio): o balcão registra a venda de atacado e NÃO tinha como
-- desfazer um registro errado (o varejo tem cancel_manual_order; o atacado não
-- tinha nada). Com o fiado (0115) o buraco piorou: venda fiada registrada errada
-- vira "a receber" fantasma. O status 'cancelled' JÁ existe no CHECK da 0110
-- ("cancela sem apagar") — faltava a TRILHA de quem/quando/por quê.
--
-- O que o cancelamento corrige SOZINHO (tudo já filtra status='confirmed'):
--   ranking de recompra (wholesale_buyer_summary), resumo faturamento/custo/lucro
--   (getWholesaleResumo) e o fiado a receber (getWholesaleFinance 0115).
-- A DEVOLUÇÃO do estoque é código (espelho da baixa, flag WHOLESALE_STOCK_DECREMENT).
--
-- 100% ADITIVA. Rollback no fim (comentado).
-- Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-02
-- ============================================================

ALTER TABLE commerce.wholesale_orders
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

COMMENT ON COLUMN commerce.wholesale_orders.cancelled_at IS
  '0116: quando a venda foi cancelada (status=cancelled). Trilha; NULL em venda viva.';
COMMENT ON COLUMN commerce.wholesale_orders.cancelled_by IS
  '0116: quem cancelou (operator label do painel). Trilha de auditoria.';
COMMENT ON COLUMN commerce.wholesale_orders.cancel_reason IS
  '0116: motivo em texto livre (opcional, o painel limita 300).';

-- ─────────────────────────────────────────────
-- VALIDAÇÃO PÓS-MIGRATION
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_cols INTEGER;
  v_sel  BOOLEAN;
BEGIN
  SELECT count(*) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'commerce' AND table_name = 'wholesale_orders'
     AND column_name IN ('cancelled_at', 'cancelled_by', 'cancel_reason');
  IF v_cols <> 3 THEN
    RAISE EXCEPTION '0116 falhou: esperava 3 colunas de trilha, achei %', v_cols;
  END IF;

  SELECT has_table_privilege('farejador_partner_app', 'commerce.wholesale_orders', 'SELECT') INTO v_sel;
  IF v_sel THEN
    RAISE EXCEPTION '0116 falhou: farejador_partner_app NAO deveria ler wholesale_orders';
  END IF;

  RAISE NOTICE '0116 OK: trilha de cancelamento pronta (cancelled_at/by/reason); parceiro segue sem acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   ALTER TABLE commerce.wholesale_orders
--     DROP COLUMN IF EXISTS cancelled_at,
--     DROP COLUMN IF EXISTS cancelled_by,
--     DROP COLUMN IF EXISTS cancel_reason;
-- ============================================================
