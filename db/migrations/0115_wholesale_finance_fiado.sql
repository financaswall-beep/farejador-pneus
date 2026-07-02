-- ============================================================
-- 0115_wholesale_finance_fiado.sql
-- ATACADO — FINANCEIRO (fatia 1): o FIADO dos dois lados do galpão.
--
-- Contexto (negócio): o dono é atacadista. A venda pro borracheiro e a compra do
-- fornecedor hoje são registradas como se TUDO fosse à vista. Na vida real tem
-- fiado dos dois lados: o borracheiro leva e "acerta na sexta" (A RECEBER) e o
-- fornecedor entrega e recebe depois (A PAGAR). Sem registrar isso, o caixa do
-- galpão mente por omissão.
--
-- Desenho: COPIA a planta do finance.partner_* (status aberto/pago + vencimento +
-- quitação) mas mora em commerce.wholesale_* — regra de ouro do atacado: dado SÓ
-- da matriz, ZERO grant pro farejador_partner_app (finance.* é território do
-- PARCEIRO, com grant+RLS pro app dele; o dinheiro do galpão NÃO entra lá).
--
-- Vocabulário: 'pending' = fiado/em aberto — o MESMO que a 0114 já reservou no
-- CHECK de wholesale_purchases.payment_status ("'pending' destrava contas a pagar
-- sem refazer schema" — decisão do dono 2026-06-30, honrada aqui).
--
-- 100% ADITIVA, defaults preservam o comportamento de hoje (tudo nasce 'paid').
-- DORMENTE até o backend subir (flag WHOLESALE_FINANCE, default OFF).
-- Rollback no fim (comentado). Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-02
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. VENDA DE ATACADO (wholesale_orders): campos de pagamento
--    (a compra JÁ tem payment_status desde a 0114; a venda não tinha nada)
-- ─────────────────────────────────────────────
ALTER TABLE commerce.wholesale_orders
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid'
    CHECK (payment_status IN ('paid', 'pending')),
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

COMMENT ON COLUMN commerce.wholesale_orders.payment_status IS
  '0115: paid = recebido; pending = FIADO (a receber do borracheiro). Default paid = comportamento de antes.';
COMMENT ON COLUMN commerce.wholesale_orders.due_date IS
  '0115: vencimento do fiado (opcional — "me paga quando puder" existe). Vencido = pending com due_date < hoje.';
COMMENT ON COLUMN commerce.wholesale_orders.paid_at IS
  '0115: quando o fiado foi QUITADO (ou a venda à vista registrada, com a flag on). NULL em linhas antigas.';

-- ─────────────────────────────────────────────
-- 2. COMPRA DE ATACADO (wholesale_purchases): vencimento + quitação
--    (payment_status paid|pending JÁ existe — 0114 deixou a porta aberta)
-- ─────────────────────────────────────────────
ALTER TABLE commerce.wholesale_purchases
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

COMMENT ON COLUMN commerce.wholesale_purchases.due_date IS
  '0115: vencimento do A PAGAR ao fornecedor (payment_status=pending, porta aberta na 0114).';
COMMENT ON COLUMN commerce.wholesale_purchases.paid_at IS
  '0115: quando a compra fiada foi QUITADA. NULL em linhas antigas/à vista.';

-- ─────────────────────────────────────────────
-- 3. ÍNDICES PARCIAIS — as listas do financeiro são sempre "os em aberto"
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS wholesale_orders_pending_idx
  ON commerce.wholesale_orders(environment, due_date)
  WHERE payment_status = 'pending' AND status = 'confirmed';

CREATE INDEX IF NOT EXISTS wholesale_purchases_pending_idx
  ON commerce.wholesale_purchases(environment, due_date)
  WHERE payment_status = 'pending' AND status = 'confirmed';

-- ─────────────────────────────────────────────
-- 4. VALIDAÇÃO PÓS-MIGRATION (colunas existem + defaults certos + parceiro segue ZERO)
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_cols INTEGER;
  v_sel  BOOLEAN;
  v_paid INTEGER;
BEGIN
  SELECT count(*) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'commerce'
     AND ((table_name = 'wholesale_orders'    AND column_name IN ('payment_status','payment_method','due_date','paid_at'))
       OR (table_name = 'wholesale_purchases' AND column_name IN ('due_date','paid_at')));
  IF v_cols <> 6 THEN
    RAISE EXCEPTION '0115 falhou: esperava 6 colunas novas, achei %', v_cols;
  END IF;

  -- Linhas antigas TODAS 'paid' (default aplicou; nada virou fiado sem querer).
  SELECT count(*) INTO v_paid FROM commerce.wholesale_orders WHERE payment_status <> 'paid';
  IF v_paid <> 0 THEN
    RAISE EXCEPTION '0115 falhou: % venda(s) antigas nao-paid (default nao aplicou?)', v_paid;
  END IF;

  -- Regra de ouro intacta: parceiro NÃO enxerga o atacado.
  SELECT has_table_privilege('farejador_partner_app', 'commerce.wholesale_orders', 'SELECT') INTO v_sel;
  IF v_sel THEN
    RAISE EXCEPTION '0115 falhou: farejador_partner_app NAO deveria ler wholesale_orders';
  END IF;

  RAISE NOTICE '0115 OK: fiado (payment_status/due_date/paid_at) pronto na venda e na compra; parceiro segue sem acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP INDEX IF EXISTS commerce.wholesale_orders_pending_idx;
--   DROP INDEX IF EXISTS commerce.wholesale_purchases_pending_idx;
--   ALTER TABLE commerce.wholesale_orders
--     DROP COLUMN IF EXISTS payment_status, DROP COLUMN IF EXISTS payment_method,
--     DROP COLUMN IF EXISTS due_date, DROP COLUMN IF EXISTS paid_at;
--   ALTER TABLE commerce.wholesale_purchases
--     DROP COLUMN IF EXISTS due_date, DROP COLUMN IF EXISTS paid_at;
-- (Aditiva e dormente: com a flag OFF ninguém escreve 'pending' — rollback é seguro.)
-- ============================================================
