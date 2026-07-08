-- ============================================================
-- 0130_matriz_expense_categories.sql
-- FINANCEIRO DA MATRIZ — MODALIDADE de despesa CADASTRÁVEL pelo dono.
--
-- Contexto (negócio): a 0120 travou a categoria num CHECK de 6 valores e o
-- próprio comentário dela previu "ajustável por migration futura se o dono
-- pedir outras". O dono pediu (07-08): pedágio, alimentação etc. caíam TODOS
-- em "outros" — inclusive na IA de comprovante, que joga pedágio/estacionamento/
-- lanche em "outros" DE PROPÓSITO por não ter onde pendurar.
--
-- Desenho: tabela de modalidades (as 6 de fábrica is_system + as do dono),
-- PK (environment, slug) porque test e prod moram no MESMO banco físico —
-- modalidade criada numa prova de test NÃO pode aparecer no dropdown de prod.
-- O CHECK fixo SAI e entra FK composta: integridade continua no BANCO (contrato),
-- só que agora contra uma lista viva. Modalidade não se apaga: ARQUIVA
-- (archived_at) — despesa antiga segue íntegra e com rótulo.
--
-- Regra de ouro: dado SÓ da matriz (commerce.*), ZERO grant pro
-- farejador_partner_app (revogado e provado abaixo, padrão 0120).
--
-- 100% ADITIVA no comportamento atual: as 6 categorias continuam válidas,
-- nenhuma despesa muda. Rollback no fim (comentado).
-- Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-08
-- ============================================================

CREATE TABLE IF NOT EXISTS commerce.matriz_expense_categories (
  environment env_t NOT NULL,
  slug        TEXT NOT NULL CHECK (slug ~ '^[a-z0-9_]{2,40}$'),
  label       TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 2 AND 40),
  is_system   BOOLEAN NOT NULL DEFAULT false,  -- as 6 de fábrica: não arquiváveis ('outros' é fallback da IA)
  archived_at TIMESTAMPTZ,                     -- arquivada = some do form; despesa antiga fica íntegra
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, slug)
);

COMMENT ON TABLE commerce.matriz_expense_categories IS
  '0130: modalidades de despesa da matriz — as 6 de fábrica (is_system) + as que o dono cadastra. Slug normalizado sem acento; label é o rótulo da tela. Arquivar esconde do form sem tocar despesa antiga. SÓ matriz — zero grant pro parceiro.';
COMMENT ON COLUMN commerce.matriz_expense_categories.is_system IS
  '0130: de fábrica (aluguel/funcionario/combustivel/frete/manutencao/outros). Não arquivável — "outros" é o fallback da IA de comprovante.';

-- Seeds de fábrica nos DOIS envs (labels = os que o painel já mostrava).
INSERT INTO commerce.matriz_expense_categories (environment, slug, label, is_system) VALUES
  ('prod', 'aluguel',     'Aluguel/galpão', true),
  ('prod', 'funcionario', 'Funcionário',    true),
  ('prod', 'combustivel', 'Combustível',    true),
  ('prod', 'frete',       'Frete pago',     true),
  ('prod', 'manutencao',  'Manutenção',     true),
  ('prod', 'outros',      'Outros',         true),
  ('test', 'aluguel',     'Aluguel/galpão', true),
  ('test', 'funcionario', 'Funcionário',    true),
  ('test', 'combustivel', 'Combustível',    true),
  ('test', 'frete',       'Frete pago',     true),
  ('test', 'manutencao',  'Manutenção',     true),
  ('test', 'outros',      'Outros',         true)
ON CONFLICT (environment, slug) DO NOTHING;

-- Robustez: qualquer categoria que JÁ exista nas despesas vira linha (o CHECK
-- antigo só permitia as 6, então isto é cinto e suspensório antes da FK).
INSERT INTO commerce.matriz_expense_categories (environment, slug, label, is_system)
SELECT DISTINCT e.environment, e.category, initcap(e.category), true
  FROM commerce.matriz_expenses e
ON CONFLICT (environment, slug) DO NOTHING;

-- O muro fixo sai; a FK viva entra (RESTRICT default: categoria com despesa não some).
ALTER TABLE commerce.matriz_expenses DROP CONSTRAINT IF EXISTS matriz_expenses_category_check;
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matriz_expenses_category_fk') THEN
    ALTER TABLE commerce.matriz_expenses
      ADD CONSTRAINT matriz_expenses_category_fk
      FOREIGN KEY (environment, category)
      REFERENCES commerce.matriz_expense_categories (environment, slug);
  END IF;
END;
$fk$;

-- Índice do filtro novo da tela ("despesas do mês × categoria") + cobre a FK.
CREATE INDEX IF NOT EXISTS matriz_expenses_category_idx
  ON commerce.matriz_expenses (environment, category, occurred_at DESC)
  WHERE deleted_at IS NULL;

-- Regra de ouro: parceiro NÃO enxerga dado da matriz.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    REVOKE ALL ON commerce.matriz_expense_categories FROM farejador_partner_app;
  END IF;
END;
$grant$;

-- ─────────────────────────────────────────────
-- VALIDAÇÃO PÓS-MIGRATION (padrão 0128: smoke DENTRO — se falhar, aborta tudo)
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_seeds_prod INT;
  v_seeds_test INT;
  v_orfas      INT;
  v_sel        BOOLEAN;
  v_ins        BOOLEAN;
  v_fantasma_barrada BOOLEAN := false;
BEGIN
  IF to_regclass('commerce.matriz_expense_categories') IS NULL THEN
    RAISE EXCEPTION '0130 falhou: tabela de modalidades nao existe';
  END IF;

  SELECT COUNT(*) INTO v_seeds_prod FROM commerce.matriz_expense_categories WHERE environment = 'prod' AND is_system;
  SELECT COUNT(*) INTO v_seeds_test FROM commerce.matriz_expense_categories WHERE environment = 'test' AND is_system;
  IF v_seeds_prod < 6 OR v_seeds_test < 6 THEN
    RAISE EXCEPTION '0130 falhou: seeds de fabrica incompletos (prod=%, test=%)', v_seeds_prod, v_seeds_test;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matriz_expenses_category_check') THEN
    RAISE EXCEPTION '0130 falhou: CHECK antigo ainda de pe';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matriz_expenses_category_fk') THEN
    RAISE EXCEPTION '0130 falhou: FK nova nao entrou';
  END IF;

  -- Nenhuma despesa órfã (a FK acabou de validar isso, mas a prova fica explícita).
  SELECT COUNT(*) INTO v_orfas
    FROM commerce.matriz_expenses e
   WHERE NOT EXISTS (SELECT 1 FROM commerce.matriz_expense_categories c
                      WHERE c.environment = e.environment AND c.slug = e.category);
  IF v_orfas > 0 THEN
    RAISE EXCEPTION '0130 falhou: % despesa(s) orfa(s) de categoria', v_orfas;
  END IF;

  -- SMOKE: categoria fantasma tem que BARRAR na FK.
  BEGIN
    INSERT INTO commerce.matriz_expenses (environment, category, amount, created_by)
    VALUES ('test', 'fantasma_0130', 1.00, '0130-smoke');
    RAISE EXCEPTION '0130 falhou: INSERT com categoria fantasma PASSOU (FK nao segura)';
  EXCEPTION
    WHEN foreign_key_violation THEN v_fantasma_barrada := true;
  END;
  IF NOT v_fantasma_barrada THEN
    RAISE EXCEPTION '0130 falhou: smoke da FK nao rodou';
  END IF;

  -- SMOKE: o caminho feliz continua vivo (categoria seedada entra e sai).
  INSERT INTO commerce.matriz_expenses (environment, category, amount, created_by)
  VALUES ('test', 'outros', 1.00, '0130-smoke');
  DELETE FROM commerce.matriz_expenses WHERE created_by = '0130-smoke';

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    SELECT has_table_privilege('farejador_partner_app', 'commerce.matriz_expense_categories', 'SELECT') INTO v_sel;
    SELECT has_table_privilege('farejador_partner_app', 'commerce.matriz_expense_categories', 'INSERT') INTO v_ins;
    IF v_sel OR v_ins THEN
      RAISE EXCEPTION '0130 falhou: parceiro NAO deveria acessar modalidades (select=%, insert=%)', v_sel, v_ins;
    END IF;
  END IF;

  RAISE NOTICE '0130 OK: modalidades vivas (6 de fabrica x 2 envs), CHECK fixo fora, FK segurando, parceiro sem acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   ALTER TABLE commerce.matriz_expenses DROP CONSTRAINT IF EXISTS matriz_expenses_category_fk;
--   ALTER TABLE commerce.matriz_expenses ADD CONSTRAINT matriz_expenses_category_check
--     CHECK (category IN ('aluguel','funcionario','combustivel','frete','manutencao','outros'));
--   -- (só é seguro se nenhuma despesa usar categoria nova; senão, migrar antes)
--   DROP INDEX IF EXISTS commerce.matriz_expenses_category_idx;
--   DROP TABLE IF EXISTS commerce.matriz_expense_categories;
-- ============================================================
