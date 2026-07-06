-- ============================================================
-- 0126_wholesale_stock_min_quantity.sql
-- GALPÃO — ESTOQUE MÍNIMO por medida (alerta de reposição).
--
-- Contexto (negócio, 2026-07-06): três bocas dão baixa do MESMO galpão (bot,
-- balcão da matriz e venda de atacado) e ninguém vigia a soma — a medida só
-- ficava vermelha no ZERO, tarde demais pra um atacadista (no zero já perdeu
-- venda). O estoque do PARCEIRO já tem mínimo (minimum_quantity); o do dono não
-- tinha. Esta migration dá ao galpão o mesmo conceito: min_quantity por medida.
--
-- Decisões:
--   • NULL = "sem mínimo definido" → NUNCA alerta (opt-in por medida; nada de
--     default mágico que encheria o sino de falso alarme no dia 1).
--   • O alerta é LEITURA (badge "repor" na aba Estoque + sino do Resumo):
--     qty <= min. NENHUMA escrita/trava depende disso — não toca baixa nem venda.
--
-- Segurança: mesma regra de ouro do 0111 — dado SÓ da matriz, ZERO grant pro
-- farejador_partner_app (coluna nova herda; provado na validação §2).
--
-- 100% ADITIVA. Não toca 0076/0077 nem as baixas (0111/0117). Rollback no fim.
-- Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-06
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. COLUNA min_quantity (nullable = sem alerta)
-- ─────────────────────────────────────────────
ALTER TABLE commerce.wholesale_stock
  ADD COLUMN IF NOT EXISTS min_quantity INTEGER
    CHECK (min_quantity IS NULL OR min_quantity >= 0);

COMMENT ON COLUMN commerce.wholesale_stock.min_quantity IS
  'Estoque MINIMO da medida (0126): qty <= min => alerta "repor" na aba Estoque e no sino do Resumo. NULL = sem minimo definido (nao alerta). So leitura/aviso: nenhuma baixa ou venda trava por isso.';

-- ─────────────────────────────────────────────
-- 2. VALIDAÇÃO PÓS-MIGRATION (coluna existe + parceiro segue SEM acesso)
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_col INTEGER;
  v_sel BOOLEAN;
BEGIN
  SELECT count(*) INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'commerce' AND table_name = 'wholesale_stock'
     AND column_name = 'min_quantity';
  IF v_col <> 1 THEN
    RAISE EXCEPTION '0126 falhou: coluna min_quantity nao criada (achei %)', v_col;
  END IF;

  -- Regra de ouro do atacado (0111): o role do parceiro NÃO enxerga o galpão.
  SELECT has_table_privilege('farejador_partner_app', 'commerce.wholesale_stock', 'SELECT') INTO v_sel;
  IF v_sel THEN
    RAISE EXCEPTION '0126 falhou: farejador_partner_app NAO deveria ler wholesale_stock';
  END IF;

  RAISE NOTICE '0126 OK: min_quantity criada (NULL = sem alerta), parceiro segue sem acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   ALTER TABLE commerce.wholesale_stock DROP COLUMN IF EXISTS min_quantity;
-- (Coluna nullable e só de leitura — dropar não quebra baixa nem venda.)
-- ============================================================
