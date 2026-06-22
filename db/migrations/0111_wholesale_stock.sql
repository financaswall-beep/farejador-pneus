-- ============================================================
-- 0111_wholesale_stock.sql
-- ATACADO (Fase 2) — ESTOQUE DO GALPÃO por MEDIDA (pneu usado).
--
-- Contexto (negócio): o dono é atacadista de pneu USADO e controla o galpão por
-- MEDIDA simples (ex.: '90/90-18' = 15 unidades), NÃO por produto-com-posição como
-- o catálogo do varejo (commerce.stock_levels, que separa dianteiro/traseiro/radial).
-- Esta migration cria a "gaveta" do estoque de atacado por medida. A tela "Estoque
-- do galpão" (Fase 2) gerencia; a venda de atacado dá BAIXA aqui (Fase 2b, atrás de flag).
--
-- Decisões (2026-06-22, dono):
--   • Estoque por MEDIDA + unidades, cada medida = 1 linha ("15 de 90/90-18").
--   • SEPARADO do estoque do varejo (stock_levels é por product_id c/ posição, e hoje
--     é semente que vai zerar no go-live). Unificar varejo↔atacado = obra futura
--     (mexe no bot) — ver memória project_virada_producao.
--   • A BAIXA nunca trava a venda (a venda é o dinheiro): clamp em 0 no código, por
--     isso quantity_on_hand fica CHECK >= 0 (a tela e a baixa nunca mandam negativo).
--
-- Segurança: dado SÓ DA MATRIZ, igual 0110 → ZERO grant pro farejador_partner_app
-- (provado no bloco §4). Sem RLS de propósito (single-tenant; a dona acessa como owner).
--
-- 100% ADITIVA. NÃO toca o contrato 0076/0077 (estoque/financeiro do parceiro) nem o
-- stock_levels do varejo. DORMENTE até a UI/backend da Fase 2 subir (cria tabela vazia).
-- Rollback no fim do arquivo (comentado).
-- Assinatura: Orquestrador (Claude Opus 4.8) — banco/matriz, 2026-06-22
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. ESTOQUE DO GALPÃO POR MEDIDA
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.wholesale_stock (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment       env_t NOT NULL,

  measure           TEXT NOT NULL,                              -- medida simples (ex.: '90/90-18')
  quantity_on_hand  INTEGER NOT NULL DEFAULT 0
                      CHECK (quantity_on_hand >= 0),            -- a baixa clampa em 0; nunca negativo
  notes             TEXT,                                       -- observação livre (opcional)

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE commerce.wholesale_stock IS
  'Estoque do galpao da Matriz por MEDIDA (0111, atacado Fase 2). Pneu usado: medida simples sem posicao, quantidade por medida. SEPARADO do stock_levels do varejo. Dado SO da matriz: SEM grant pro farejador_partner_app.';

-- Uma linha por medida (por ambiente) — é a chave do upsert do estoque e da baixa.
CREATE UNIQUE INDEX IF NOT EXISTS wholesale_stock_measure_uniq
  ON commerce.wholesale_stock(environment, measure);

-- ─────────────────────────────────────────────
-- 2. TRIGGERS — updated_at + ambiente imutável (padrão 0110/0021)
-- ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS wholesale_stock_set_updated_at ON commerce.wholesale_stock;
CREATE TRIGGER wholesale_stock_set_updated_at
  BEFORE UPDATE ON commerce.wholesale_stock
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

-- environment IMUTÁVEL após INSERT (padrão 0021 — toda tabela env_t que sofre UPDATE).
DROP TRIGGER IF EXISTS env_immutable_wholesale_stock ON commerce.wholesale_stock;
CREATE TRIGGER env_immutable_wholesale_stock
  BEFORE UPDATE OF environment ON commerce.wholesale_stock
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

-- ─────────────────────────────────────────────
-- 3. GRANTS — NENHUM pro parceiro (atacado é da matriz; a dona acessa como owner)
-- ─────────────────────────────────────────────
-- (De propósito SEM `GRANT ... TO farejador_partner_app`. Regra de ouro do atacado,
--  igual 0110: o role do parceiro tem ZERO privilégio aqui — provado na §4.)

-- ─────────────────────────────────────────────
-- 4. VALIDAÇÃO PÓS-MIGRATION (tabela existe + parceiro NÃO enxerga)
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_tbl INTEGER;
  v_sel BOOLEAN;
  v_ins BOOLEAN;
BEGIN
  SELECT count(*) INTO v_tbl
    FROM information_schema.tables
   WHERE table_schema = 'commerce' AND table_name = 'wholesale_stock';
  IF v_tbl <> 1 THEN
    RAISE EXCEPTION '0111 falhou: tabela wholesale_stock nao criada (achei %)', v_tbl;
  END IF;

  -- Regra de ouro: o role do parceiro NÃO pode ler nem escrever o estoque do atacado.
  SELECT has_table_privilege('farejador_partner_app', 'commerce.wholesale_stock', 'SELECT') INTO v_sel;
  SELECT has_table_privilege('farejador_partner_app', 'commerce.wholesale_stock', 'INSERT') INTO v_ins;
  IF v_sel OR v_ins THEN
    RAISE EXCEPTION '0111 falhou: farejador_partner_app NAO deveria acessar wholesale_stock (select=%, insert=%)', v_sel, v_ins;
  END IF;

  RAISE NOTICE '0111 OK: wholesale_stock criada, parceiro SEM acesso ao estoque do atacado.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP TABLE IF EXISTS commerce.wholesale_stock;
-- (índice e triggers caem com a tabela. Zero dado existente — fundação dormente.)
-- ============================================================
