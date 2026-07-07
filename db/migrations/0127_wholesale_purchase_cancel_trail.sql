-- ============================================================
-- 0127_wholesale_purchase_cancel_trail.sql
-- COMPRAS — CANCELAR COMPRA: a trilha do cancelamento (espelho da 0116 da venda).
--
-- Contexto (negócio, auditoria da aba Compras 2026-07-06): a compra registrada
-- errada era INVISÍVEL (sem lista na tela) e IRREVERSÍVEL (sem cancelar). O status
-- 'cancelled' JÁ existe no CHECK da 0114 ("cancela sem apagar") — faltava a TRILHA
-- de quem/quando/por quê, igual à venda (0116).
--
-- O que o cancelamento corrige SOZINHO (tudo já filtra status='confirmed'):
--   ranking de fornecedor (wholesale_supplier_summary), preço por medida
--   (getWholesaleSupplierMeasureBreakdown) e o a pagar (getWholesaleFinance 0115).
-- A REVERSÃO do galpão é código (inverso ponderado da entrada, com clamp honesto —
-- mesma família de assimetria documentada no 0116; correção real = livro-razão Fase B).
--
-- 100% ADITIVA. Rollback no fim (comentado).
-- Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-06
-- ============================================================

ALTER TABLE commerce.wholesale_purchases
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

COMMENT ON COLUMN commerce.wholesale_purchases.cancelled_at IS
  '0127: quando a compra foi cancelada (status=cancelled). Trilha; NULL em compra viva.';
COMMENT ON COLUMN commerce.wholesale_purchases.cancelled_by IS
  '0127: quem cancelou (operator label do painel). Trilha de auditoria.';
COMMENT ON COLUMN commerce.wholesale_purchases.cancel_reason IS
  '0127: motivo em texto livre (opcional, o painel limita 300).';

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
   WHERE table_schema = 'commerce' AND table_name = 'wholesale_purchases'
     AND column_name IN ('cancelled_at', 'cancelled_by', 'cancel_reason');
  IF v_cols <> 3 THEN
    RAISE EXCEPTION '0127 falhou: esperava 3 colunas de trilha, achei %', v_cols;
  END IF;

  SELECT has_table_privilege('farejador_partner_app', 'commerce.wholesale_purchases', 'SELECT') INTO v_sel;
  IF v_sel THEN
    RAISE EXCEPTION '0127 falhou: farejador_partner_app NAO deveria ler wholesale_purchases';
  END IF;

  RAISE NOTICE '0127 OK: trilha de cancelamento da compra pronta (cancelled_at/by/reason); parceiro segue sem acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   ALTER TABLE commerce.wholesale_purchases
--     DROP COLUMN IF EXISTS cancelled_at,
--     DROP COLUMN IF EXISTS cancelled_by,
--     DROP COLUMN IF EXISTS cancel_reason;
-- ============================================================
