-- ============================================================
-- 0105_satisfaction_surveys.sql
-- Pesquisa de satisfação (estrelas ⭐) — FUNDAÇÃO DE DADOS (Tijolo 1).
--
-- Contexto: quando o parceiro marca "entregue" (entrega) ou "retirado" (retirada)
-- no painel, o sistema pergunta a nota (1-5) ao cliente no WhatsApp e guarda por
-- loja (ranking INTERNO/discreto — anti-fofoca em rede pequena). A nota nasce do
-- PEDIDO (que já sabe a loja) — não depende de qual_loja_atendeu.
--
-- Espelha o padrão de segurança da foto sob demanda (0094): fila leve, RLS por
-- unidade, grants POR COLUNA (parceiro NÃO lê conversation_id/contact_id — anti-bypass
-- de comissão), e INSERT/escrita EXCLUSIVOS do bot-pool (parceiro só LÊ a própria nota).
-- DIFERENÇA vs foto: aqui quem responde é o CLIENTE (no WhatsApp), não o parceiro —
-- então o parceiro nunca escreve; enfileirar e gravar a nota é do bot-pool.
--
-- 100% ADITIVA. NÃO toca o contrato 0076/0077 (estoque/financeiro).
-- Flag de runtime: SATISFACTION_SURVEY (default OFF) — migration DORMENTE.
-- Rollback no fim do arquivo (comentado).
-- Assinatura: Orquestrador (Claude Opus 4.8) — banco, 2026-06-14
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. FILA / MÁQUINA DE ESTADOS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.satisfaction_surveys (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment         env_t NOT NULL,
  unit_id             UUID NOT NULL REFERENCES core.units(id),   -- a loja avaliada (do pedido)

  -- Pedido que disparou a pesquisa (sabe a loja, o modo e o cliente).
  partner_order_id    UUID REFERENCES commerce.partner_orders(id),
  fulfillment_mode    TEXT CHECK (fulfillment_mode IN ('delivery', 'pickup')),

  -- Endereço de volta (por onde manda a pergunta e casa a resposta). IDs do Chatwoot
  -- (BIGINT, coerente com 0070/0094). SEM grant de leitura pro parceiro (anti-bypass, E2).
  -- Não é FK de propósito (mesmo motivo do 0094).
  conversation_id     BIGINT NOT NULL,
  contact_id          BIGINT,

  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN (
                          'pending',    -- criada, pergunta enviada, esperando a nota
                          'answered',   -- cliente respondeu a nota
                          'expired',    -- janela fechou sem resposta
                          'cancelled'   -- cancelada (ex.: pedido cancelado)
                        )),
  rating              SMALLINT CHECK (rating BETWEEN 1 AND 5),  -- a nota (1-5), nula até responder
  comment             TEXT,                                     -- comentário livre opcional

  asked_at            TIMESTAMPTZ,                              -- quando a pergunta foi enviada
  answered_at         TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A nota só existe em 'answered' (e 'answered' exige nota).
  CONSTRAINT satisfaction_rating_iff_answered
    CHECK ((status = 'answered') = (rating IS NOT NULL))
);

COMMENT ON TABLE commerce.satisfaction_surveys IS
  'Fila/maquina de estados da pesquisa de satisfacao por estrelas (0105). Disparada quando o parceiro marca entregue/retirado; nota (1-5) respondida pelo CLIENTE no WhatsApp. RLS por unidade (parceiro le so a propria nota, SEM conversation_id/contact_id). INSERT/escrita so bot-pool. Flag SATISFACTION_SURVEY (default OFF, dormente).';

-- ─────────────────────────────────────────────
-- 2. ÍNDICES
-- ─────────────────────────────────────────────
-- Expirador: as pendentes cuja janela já fechou.
CREATE INDEX IF NOT EXISTS satisfaction_surveys_expiring_idx
  ON commerce.satisfaction_surveys(expires_at)
  WHERE status = 'pending';

-- Casar a resposta do cliente: achar a pesquisa pendente daquela conversa.
CREATE INDEX IF NOT EXISTS satisfaction_surveys_conversation_idx
  ON commerce.satisfaction_surveys(environment, conversation_id)
  WHERE status = 'pending';

-- Ranking por loja.
CREATE INDEX IF NOT EXISTS satisfaction_surveys_unit_idx
  ON commerce.satisfaction_surveys(environment, unit_id, created_at DESC);

-- Anti-duplicata: 1 pesquisa por pedido (parcial — só quando há pedido).
CREATE UNIQUE INDEX IF NOT EXISTS satisfaction_surveys_order_uniq
  ON commerce.satisfaction_surveys(partner_order_id)
  WHERE partner_order_id IS NOT NULL;

-- ─────────────────────────────────────────────
-- 3. TRIGGERS (updated_at + invariante de ambiente — padrão 0094)
-- ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS satisfaction_surveys_set_updated_at ON commerce.satisfaction_surveys;
CREATE TRIGGER satisfaction_surveys_set_updated_at
  BEFORE UPDATE ON commerce.satisfaction_surveys
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS env_match_satisfaction_surveys_unit ON commerce.satisfaction_surveys;
CREATE TRIGGER env_match_satisfaction_surveys_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON commerce.satisfaction_surveys
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

-- ─────────────────────────────────────────────
-- 4. RLS — isolamento por unidade (cópia do 0094)
-- ─────────────────────────────────────────────
ALTER TABLE commerce.satisfaction_surveys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS satisfaction_surveys_isolation ON commerce.satisfaction_surveys;
CREATE POLICY satisfaction_surveys_isolation ON commerce.satisfaction_surveys
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  );

-- ─────────────────────────────────────────────
-- 5. VIEW DA NOTA — whitelist do que o parceiro lê (E2: sem o endereço de volta)
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW commerce.partner_satisfaction
WITH (security_invoker = true) AS
  SELECT
    s.id,
    s.unit_id,
    s.partner_order_id,
    s.fulfillment_mode,
    s.status,
    s.rating,
    s.comment,
    s.asked_at,
    s.answered_at,
    s.created_at
  FROM commerce.satisfaction_surveys s;

COMMENT ON VIEW commerce.partner_satisfaction IS
  'Notas de satisfacao visiveis ao parceiro (0105). security_invoker -> RLS por unidade. WHITELIST: sem conversation_id/contact_id (anti-bypass, E2).';

-- ─────────────────────────────────────────────
-- 6. GRANTS — POR COLUNA (parceiro SÓ LÊ a própria nota; NÃO escreve, NÃO lê o contato)
-- ─────────────────────────────────────────────
GRANT SELECT (id, environment, unit_id, partner_order_id, fulfillment_mode,
              status, rating, comment, asked_at, answered_at, expires_at,
              created_at, updated_at)
  ON commerce.satisfaction_surveys TO farejador_partner_app;

GRANT SELECT ON commerce.partner_satisfaction TO farejador_partner_app;

-- (SEM INSERT/UPDATE/DELETE pro parceiro: enfileirar e gravar a nota é EXCLUSIVO do
--  bot-pool — a nota vem do CLIENTE no WhatsApp, o parceiro nunca escreve. Validado na §8.)

-- ─────────────────────────────────────────────
-- 7. (reservado — funções de enfileirar/gravar nota + expirador entram nos Tijolos 2/3)
-- ─────────────────────────────────────────────

-- ─────────────────────────────────────────────
-- 8. VALIDAÇÃO PÓS-MIGRATION (padrão 0094)
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_rls   BOOLEAN;
  v_pol   INTEGER;
  v_ins   BOOLEAN;
  v_upd   BOOLEAN;
  v_conv  BOOLEAN;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class WHERE oid = 'commerce.satisfaction_surveys'::regclass;
  SELECT count(*) INTO v_pol
    FROM pg_policies WHERE schemaname='commerce' AND tablename='satisfaction_surveys';

  IF NOT v_rls THEN
    RAISE EXCEPTION '0105 falhou: RLS nao habilitado em satisfaction_surveys';
  END IF;
  IF v_pol < 1 THEN
    RAISE EXCEPTION '0105 falhou: esperava >=1 policy, achei %', v_pol;
  END IF;

  -- Parceiro NÃO pode enfileirar nem editar (escrita é do bot-pool).
  SELECT has_table_privilege('farejador_partner_app', 'commerce.satisfaction_surveys', 'INSERT') INTO v_ins;
  SELECT has_table_privilege('farejador_partner_app', 'commerce.satisfaction_surveys', 'UPDATE') INTO v_upd;
  IF v_ins OR v_upd THEN
    RAISE EXCEPTION '0105 falhou: farejador_partner_app NAO deveria ter INSERT/UPDATE (ins=%, upd=%)', v_ins, v_upd;
  END IF;

  -- Parceiro NÃO lê o endereço de volta (anti-bypass).
  SELECT has_column_privilege('farejador_partner_app', 'commerce.satisfaction_surveys',
                              'conversation_id', 'SELECT') INTO v_conv;
  IF v_conv THEN
    RAISE EXCEPTION '0105 falhou: farejador_partner_app NAO deveria ler conversation_id';
  END IF;

  RAISE NOTICE '0105 OK: RLS on, % policy(s), INSERT/UPDATE negados ao parceiro, conversation_id ilegivel.', v_pol;
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   DROP VIEW  IF EXISTS commerce.partner_satisfaction;
--   DROP TABLE IF EXISTS commerce.satisfaction_surveys;
-- (triggers/policies/indices/grants caem com a tabela. Zero dado existente.)
-- ============================================================
