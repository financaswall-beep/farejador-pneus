-- ============================================================
-- 0128_wholesale_stock_movements.sql
-- GALPÃO — TRILHA DE MOVIMENTAÇÃO (o "filme" do estoque, por TRIGGER).
--
-- Contexto (auditoria da aba Estoque, 2026-07-07): o galpão era só a FOTO do
-- saldo (wholesale_stock.quantity_on_hand). Três+ bocas dão baixa do MESMO
-- estoque (bot, balcão da matriz, venda de atacado, compra, cancelamentos,
-- Definir da tela) e não existia o filme "entrou 10 dia tal, saiu 3 na venda X".
-- Se o número do sistema descolar do pneu físico, o dono não tem como achar
-- onde furou. Esta migration cria a trilha APPEND-ONLY, gravada por TRIGGER
-- na própria tabela — o padrão da casa (analytics = trigger SQL): pega TODA
-- escrita, de qualquer código, inclusive o que ainda vai ser escrito.
--
-- Decisões:
--   • TRIGGER, não código de aplicação: impossível "esquecer uma boca". O
--     rótulo (source/reason/ref) vem de set_config LOCAL da transação
--     (app.galpao_source / app.galpao_reason / app.galpao_ref); quem não
--     rotular ainda assim registra o DELTA — vira 'sem_rotulo', a trilha
--     NUNCA fura. DELETE sem rótulo vira 'remocao' (auto-evidente).
--   • NÃO é o livro-razão da Fase B: a fonte da verdade continua sendo o
--     saldo em wholesale_stock; NENHUMA baixa muda de comportamento. Isto é
--     observabilidade pura (e alimenta a Fase B com histórico desde já).
--   • Só loga UPDATE que MUDA quantity_on_hand ou unit_cost (mexer em notes/
--     min_quantity não é movimento de estoque).
--   • qty_delta é coluna GERADA (after − before): entrada +, saída −.
--   • SECURITY DEFINER + search_path fixo: qualquer escritor legítimo do
--     estoque consegue logar sem grant extra na tabela de movimentos.
--   • Append-only: sem UPDATE/DELETE previstos → sem trigger de updated_at.
--
-- Segurança: mesma regra de ouro do 0111 — dado SÓ da matriz, ZERO grant pro
-- farejador_partner_app (provado na validação §4).
--
-- 100% ADITIVA. Não toca 0076/0077 nem as baixas (0111/0117). A validação §4
-- inclui um SMOKE (insert/update/delete numa medida descartável) provando o
-- trigger VIVO na hora de aplicar — é caminho de venda, não pode ter mina.
-- Rollback no fim. Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-07
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. TABELA DE MOVIMENTOS (append-only)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.wholesale_stock_movements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment  env_t NOT NULL,

  measure      TEXT NOT NULL,                     -- a medida movimentada (ex.: '90/90-18')
  op           TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
  qty_before   INTEGER NOT NULL,                  -- saldo ANTES (0 no insert)
  qty_after    INTEGER NOT NULL,                  -- saldo DEPOIS (0 no delete)
  qty_delta    INTEGER GENERATED ALWAYS AS (qty_after - qty_before) STORED,
  cost_before  NUMERIC,                           -- custo médio antes (NULL no insert)
  cost_after   NUMERIC,                           -- custo médio depois (NULL no delete)

  source       TEXT NOT NULL DEFAULT 'sem_rotulo',-- quem mexeu (venda_atacado, compra, varejo, ...)
  reason       TEXT,                              -- motivo livre (ex.: 'quebra: furou na desmontagem')
  ref          TEXT,                              -- id do pedido/compra quando houver (TEXT: sem cast que exploda)

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE commerce.wholesale_stock_movements IS
  'Trilha APPEND-ONLY de movimentacao do galpao (0128): gravada por TRIGGER em wholesale_stock — toda mudanca de qty/custo vira uma linha (delta + antes/depois + rotulo via set_config local app.galpao_*). NAO e o livro-razao da Fase B: a fonte da verdade segue sendo o saldo; isto e o filme. Dado SO da matriz: SEM grant pro farejador_partner_app.';

CREATE INDEX IF NOT EXISTS wholesale_stock_movements_measure_idx
  ON commerce.wholesale_stock_movements(environment, measure, created_at DESC);
CREATE INDEX IF NOT EXISTS wholesale_stock_movements_recent_idx
  ON commerce.wholesale_stock_movements(environment, created_at DESC);

-- ─────────────────────────────────────────────
-- 2. FUNÇÃO DO TRIGGER — copia OLD/NEW + rótulo da transação; nunca faz parse
--    (settings lidos como TEXT puro com missing_ok=true → superfície de erro ~zero;
--    se ESTA função falhar, a venda falha junto — por isso o smoke na §4).
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION commerce.log_wholesale_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = commerce, pg_catalog
AS $fn$
DECLARE
  v_source TEXT := NULLIF(current_setting('app.galpao_source', true), '');
  v_reason TEXT := NULLIF(current_setting('app.galpao_reason', true), '');
  v_ref    TEXT := NULLIF(current_setting('app.galpao_ref', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO commerce.wholesale_stock_movements
      (environment, measure, op, qty_before, qty_after, cost_before, cost_after, source, reason, ref)
    VALUES
      (NEW.environment, NEW.measure, 'insert', 0, NEW.quantity_on_hand, NULL, NEW.unit_cost,
       COALESCE(v_source, 'sem_rotulo'), v_reason, v_ref);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- só movimento de verdade: mudou saldo OU custo (notes/min_quantity ficam fora)
    IF NEW.quantity_on_hand IS DISTINCT FROM OLD.quantity_on_hand
       OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
      INSERT INTO commerce.wholesale_stock_movements
        (environment, measure, op, qty_before, qty_after, cost_before, cost_after, source, reason, ref)
      VALUES
        (NEW.environment, NEW.measure, 'update', OLD.quantity_on_hand, NEW.quantity_on_hand,
         OLD.unit_cost, NEW.unit_cost, COALESCE(v_source, 'sem_rotulo'), v_reason, v_ref);
    END IF;
    RETURN NEW;
  ELSE -- DELETE (remover a medida da tela, ou faxina direta no banco)
    INSERT INTO commerce.wholesale_stock_movements
      (environment, measure, op, qty_before, qty_after, cost_before, cost_after, source, reason, ref)
    VALUES
      (OLD.environment, OLD.measure, 'delete', OLD.quantity_on_hand, 0, OLD.unit_cost, NULL,
       COALESCE(v_source, 'remocao'), v_reason, v_ref);
    RETURN OLD;
  END IF;
END;
$fn$;

DROP TRIGGER IF EXISTS wholesale_stock_log_movement ON commerce.wholesale_stock;
CREATE TRIGGER wholesale_stock_log_movement
  AFTER INSERT OR UPDATE OR DELETE ON commerce.wholesale_stock
  FOR EACH ROW EXECUTE FUNCTION commerce.log_wholesale_stock_movement();

-- ─────────────────────────────────────────────
-- 3. GRANTS — NENHUM pro parceiro (regra de ouro do atacado, igual 0111)
-- ─────────────────────────────────────────────
-- (De propósito SEM `GRANT ... TO farejador_partner_app`.)

-- ─────────────────────────────────────────────
-- 4. VALIDAÇÃO + SMOKE — trigger VIVO (insert/update/update-sem-mudança/delete)
--    numa medida descartável '0128-SMOKE', limpa no fim. Roda na transação da
--    migration: se o trigger estiver quebrado, a migration ABORTA (nada sobe).
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_sel BOOLEAN;
  v_n   INTEGER;
  v_row RECORD;
BEGIN
  -- parceiro NÃO enxerga a trilha
  SELECT has_table_privilege('farejador_partner_app', 'commerce.wholesale_stock_movements', 'SELECT') INTO v_sel;
  IF v_sel THEN
    RAISE EXCEPTION '0128 falhou: farejador_partner_app NAO deveria ler wholesale_stock_movements';
  END IF;

  -- SMOKE: com rótulo setado, o filme grava insert/update/delete (e ignora update sem mudança)
  PERFORM set_config('app.galpao_source', 'smoke_0128', true);
  PERFORM set_config('app.galpao_reason', 'migration smoke', true);
  PERFORM set_config('app.galpao_ref', '0128', true);

  INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost)
  VALUES ('test', '0128-SMOKE', 5, 10);
  UPDATE commerce.wholesale_stock SET quantity_on_hand = 3 WHERE environment='test' AND measure='0128-SMOKE';
  UPDATE commerce.wholesale_stock SET notes = 'sem movimento' WHERE environment='test' AND measure='0128-SMOKE';
  DELETE FROM commerce.wholesale_stock WHERE environment='test' AND measure='0128-SMOKE';

  SELECT count(*) INTO v_n FROM commerce.wholesale_stock_movements
   WHERE environment='test' AND measure='0128-SMOKE';
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0128 falhou no smoke: esperava 3 movimentos (insert+update+delete), achei % (update de notes nao pode logar)', v_n;
  END IF;

  SELECT qty_before, qty_after, qty_delta, source, ref INTO v_row
    FROM commerce.wholesale_stock_movements
   WHERE environment='test' AND measure='0128-SMOKE' AND op='update';
  IF v_row.qty_before <> 5 OR v_row.qty_after <> 3 OR v_row.qty_delta <> -2
     OR v_row.source <> 'smoke_0128' OR v_row.ref <> '0128' THEN
    RAISE EXCEPTION '0128 falhou no smoke: update gravou % (esperava 5->3 delta -2 source smoke_0128 ref 0128)', v_row;
  END IF;

  -- limpa o smoke (a medida já saiu; sai o filme dela também)
  DELETE FROM commerce.wholesale_stock_movements WHERE environment='test' AND measure='0128-SMOKE';

  RAISE NOTICE '0128 OK: trilha viva (trigger loga insert/update/delete com rotulo; update de notes fica fora), parceiro sem acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP TRIGGER IF EXISTS wholesale_stock_log_movement ON commerce.wholesale_stock;
--   DROP FUNCTION IF EXISTS commerce.log_wholesale_stock_movement();
--   DROP TABLE IF EXISTS commerce.wholesale_stock_movements;
-- (Trigger some primeiro → as baixas voltam a rodar sem logar; nada mais depende da tabela.)
-- ============================================================
