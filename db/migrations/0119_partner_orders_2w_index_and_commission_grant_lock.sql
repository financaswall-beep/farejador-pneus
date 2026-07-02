-- ============================================================
-- 0119_partner_orders_2w_index_and_commission_grant_lock.sql
-- REDE — follow-ups da BANCA 07-02 (obra da comissão 0118), puxados pra dentro
-- da obra do financeiro da matriz (Fase 0 do livro-caixa):
--
--   1) ÍNDICE PARCIAL pro sweep da comissão: `sweepCommissionEntries` varre as
--      vendas 2W vivas a CADA GET da tela Rede e hoje faz Seq Scan em
--      commerce.partner_orders. Com 100 lojas esse GET esquenta. O predicado
--      espelha exatamente o WHERE do sweep (source_tag='2w', vivas).
--
--   2) TRAVA FÍSICA de grant no livro de comissão (espelho da 0110): a 0118 não
--      deu grant nenhum pro parceiro (provado pela banca), mas "não deu" é
--      diferente de "revogou e provou". Defesa em profundidade: REVOKE + prova
--      has_table_privilege=false — se alguém der grant sem querer no futuro,
--      re-rodar esta migration acusa.
--
-- 100% ADITIVA, zero mudança de comportamento. Rollback no fim (comentado).
-- Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-02
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. Índice parcial das vendas 2W vivas (o que o sweep e o funil da Rede leem)
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS partner_orders_2w_alive_idx
  ON commerce.partner_orders (environment, unit_id)
  WHERE source_tag = '2w' AND deleted_at IS NULL;

COMMENT ON INDEX commerce.partner_orders_2w_alive_idx IS
  '0119: cobre o sweep da comissão (0118) e as agregações 2W da Rede — sem ele é Seq Scan a cada GET.';

-- ─────────────────────────────────────────────
-- 2. Trava física de grant no livro (REVOKE + prova, espelho da 0110)
-- ─────────────────────────────────────────────
DO $lock$
DECLARE
  v_sel BOOLEAN;
  v_ins BOOLEAN;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    REVOKE ALL ON network.commission_entries FROM farejador_partner_app;

    SELECT has_table_privilege('farejador_partner_app', 'network.commission_entries', 'SELECT') INTO v_sel;
    SELECT has_table_privilege('farejador_partner_app', 'network.commission_entries', 'INSERT') INTO v_ins;
    IF v_sel OR v_ins THEN
      RAISE EXCEPTION '0119 falhou: farejador_partner_app NAO deveria acessar network.commission_entries (select=%, insert=%)', v_sel, v_ins;
    END IF;
  END IF;

  RAISE NOTICE '0119 OK: indice parcial 2w criado; livro de comissao trancado (revoke + prova).';
END;
$lock$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP INDEX IF EXISTS commerce.partner_orders_2w_alive_idx;
--   (a trava de grant não se desfaz — revogar acesso que nunca deveria existir
--    não tem rollback; se um dia o parceiro PRECISAR ler o livro, é decisão
--    nova com view-ponte própria, não grant direto.)
-- ============================================================
