-- ============================================================
-- 0120_matriz_expenses.sql
-- FINANCEIRO DA MATRIZ — Fase A do livro-caixa: DESPESA GERAL da matriz.
--
-- Contexto (negócio): hoje a ÚNICA saída de dinheiro modelada da matriz é a
-- compra de fornecedor do atacado (0114/0115). Aluguel do galpão, funcionário,
-- combustível, frete que a MATRIZ paga — nada disso existe no sistema, então
-- "a pagar" e "saldo" da matriz mentem por omissão (gasta mais do que o sistema
-- enxerga). Esta tabela é a perna que faltava pro caixa fechar de verdade.
--
-- Desenho: espelha o VOCABULÁRIO do fiado 0115 (payment_status paid|pending +
-- due_date + paid_at) — de propósito, pro sweep do livro-razão (Fase B, 0121)
-- ler despesa, venda e compra com a MESMA régua. Categoria em CHECK curto
-- (ajustável por migration futura se o dono pedir outras).
--
-- Regra de ouro: dado SÓ da matriz. finance.partner_expenses é o livro do
-- PARCEIRO (grant+RLS pro app dele) — despesa da matriz NÃO entra lá. Esta
-- mora em commerce.* com ZERO grant pro farejador_partner_app (provado abaixo).
--
-- 100% ADITIVA e DORMENTE (flag MATRIZ_EXPENSES, default OFF — endpoint devolve
-- enabled:false e a UI se esconde). Rollback no fim (comentado).
-- Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-02
-- ============================================================

CREATE TABLE IF NOT EXISTS commerce.matriz_expenses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment    env_t NOT NULL,
  category       TEXT NOT NULL
                   CHECK (category IN ('aluguel','funcionario','combustivel','frete','manutencao','outros')),
  description    TEXT,
  amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_status TEXT NOT NULL DEFAULT 'paid'
                   CHECK (payment_status IN ('paid','pending')),
  due_date       DATE,
  paid_at        TIMESTAMPTZ,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

COMMENT ON TABLE commerce.matriz_expenses IS
  '0120: despesa GERAL da matriz (aluguel/funcionario/combustivel/frete/manutencao/outros). SÓ matriz — zero grant pro parceiro. Vocabulário do fiado 0115: pending = a pagar; paid+paid_at = saiu do caixa.';
COMMENT ON COLUMN commerce.matriz_expenses.payment_status IS
  '0120: paid = pago (paid_at carimbado); pending = A PAGAR (entra no a-pagar da matriz).';
COMMENT ON COLUMN commerce.matriz_expenses.due_date IS
  '0120: vencimento do a-pagar (opcional). Vencido = pending com due_date < hoje.';
COMMENT ON COLUMN commerce.matriz_expenses.deleted_at IS
  '0120: soft delete (lançou errado). Nunca DELETE físico — trilha.';

-- Índices parciais: as leituras são sempre "em aberto" e "últimas lançadas".
CREATE INDEX IF NOT EXISTS matriz_expenses_pending_idx
  ON commerce.matriz_expenses (environment, due_date)
  WHERE payment_status = 'pending' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS matriz_expenses_recent_idx
  ON commerce.matriz_expenses (environment, occurred_at DESC)
  WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────
-- VALIDAÇÃO PÓS-MIGRATION (tabela existe + regra de ouro: parceiro ZERO acesso)
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_sel BOOLEAN;
  v_ins BOOLEAN;
BEGIN
  IF to_regclass('commerce.matriz_expenses') IS NULL THEN
    RAISE EXCEPTION '0120 falhou: commerce.matriz_expenses nao existe';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    SELECT has_table_privilege('farejador_partner_app', 'commerce.matriz_expenses', 'SELECT') INTO v_sel;
    SELECT has_table_privilege('farejador_partner_app', 'commerce.matriz_expenses', 'INSERT') INTO v_ins;
    IF v_sel OR v_ins THEN
      RAISE EXCEPTION '0120 falhou: farejador_partner_app NAO deveria acessar matriz_expenses (select=%, insert=%)', v_sel, v_ins;
    END IF;
  END IF;

  RAISE NOTICE '0120 OK: despesas da matriz prontas (dormentes, flag MATRIZ_EXPENSES); parceiro sem acesso.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP INDEX IF EXISTS commerce.matriz_expenses_pending_idx;
--   DROP INDEX IF EXISTS commerce.matriz_expenses_recent_idx;
--   DROP TABLE IF EXISTS commerce.matriz_expenses;
-- (Aditiva e dormente: com a flag OFF ninguém escreve aqui — rollback é seguro.)
-- ============================================================
