-- ============================================================
-- 0112_wholesale_cost_profit.sql
-- ATACADO (Fase 3) — CUSTO + LUCRO.
--
-- Contexto (negócio): o dono é atacadista de pneu usado — compra barato, vende. O
-- LUCRO é o jogo dele, mas a Fase 1/2 só registrava o PREÇO DE VENDA (faturamento),
-- nunca o custo. Esta migration traz o custo:
--   • custo unitário por MEDIDA no estoque do galpão (quanto pagou, em média);
--   • na venda, o custo é CONGELADO (snapshot do estoque) + o lucro da linha é gerado.
-- Assim o dono bota o custo UMA vez no estoque e toda venda calcula o lucro sozinha
-- (preço − custo). Decisão do dono 2026-06-22.
--
-- Segurança: dado SÓ da matriz (igual 0110/0111) → ZERO grant pro parceiro (não muda
-- com ADD COLUMN; reconfirmado no §validação).
-- 100% ADITIVA (ADD COLUMN com default). line_profit pode ser NEGATIVO (vendeu abaixo
-- do custo = prejuízo, informativo) — sem CHECK. Rollback no fim.
-- Assinatura: Orquestrador (Claude Opus 4.8) — banco/matriz, 2026-06-22
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. CUSTO no estoque do galpão (por medida)
-- ─────────────────────────────────────────────
ALTER TABLE commerce.wholesale_stock
  ADD COLUMN IF NOT EXISTS unit_cost numeric(12, 2) NOT NULL DEFAULT 0
    CHECK (unit_cost >= 0);

COMMENT ON COLUMN commerce.wholesale_stock.unit_cost IS
  'Custo unitario do pneu daquela medida (quanto o dono pagou, em media). Base do lucro do atacado (0112, Fase 3).';

-- ─────────────────────────────────────────────
-- 2. CUSTO (snapshot) + LUCRO na venda
-- ─────────────────────────────────────────────
ALTER TABLE commerce.wholesale_order_items
  ADD COLUMN IF NOT EXISTS unit_cost numeric(12, 2) NOT NULL DEFAULT 0
    CHECK (unit_cost >= 0);

-- Lucro da linha = (preço − custo) × quantidade. Gerado pelo banco; pode ser negativo.
ALTER TABLE commerce.wholesale_order_items
  ADD COLUMN IF NOT EXISTS line_profit numeric(12, 2)
    GENERATED ALWAYS AS ((unit_price - unit_cost) * quantity) STORED;

COMMENT ON COLUMN commerce.wholesale_order_items.unit_cost IS
  'Custo unitario CONGELADO no momento da venda (snapshot do wholesale_stock.unit_cost da medida). Trava o lucro mesmo se o custo do estoque mudar depois (0112).';
COMMENT ON COLUMN commerce.wholesale_order_items.line_profit IS
  'Lucro da linha = (unit_price - unit_cost) * quantity. Gerado pelo banco (0112).';

-- ─────────────────────────────────────────────
-- 3. VALIDAÇÃO PÓS-MIGRATION
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_cols INTEGER;
BEGIN
  SELECT count(*) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'commerce'
     AND ( (table_name = 'wholesale_stock'       AND column_name = 'unit_cost')
        OR (table_name = 'wholesale_order_items' AND column_name IN ('unit_cost', 'line_profit')) );
  IF v_cols <> 3 THEN
    RAISE EXCEPTION '0112 falhou: esperava 3 colunas novas, achei %', v_cols;
  END IF;

  -- Regra de ouro do atacado: o parceiro continua SEM acesso.
  IF has_table_privilege('farejador_partner_app', 'commerce.wholesale_stock', 'SELECT')
     OR has_table_privilege('farejador_partner_app', 'commerce.wholesale_order_items', 'SELECT') THEN
    RAISE EXCEPTION '0112 falhou: farejador_partner_app NAO deveria acessar o atacado';
  END IF;

  RAISE NOTICE '0112 OK: custo+lucro no atacado (unit_cost no estoque, unit_cost+line_profit na venda), parceiro sem acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   ALTER TABLE commerce.wholesale_order_items DROP COLUMN IF EXISTS line_profit;
--   ALTER TABLE commerce.wholesale_order_items DROP COLUMN IF EXISTS unit_cost;
--   ALTER TABLE commerce.wholesale_stock       DROP COLUMN IF EXISTS unit_cost;
-- ============================================================
