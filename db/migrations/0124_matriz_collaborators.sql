-- ============================================================
-- 0124_matriz_collaborators.sql
-- COLABORADORES DA MATRIZ — fatia 1: CADASTRO (aba Colaboradores do painel).
--
-- Contexto (decisão do dono 2026-07-04): a matriz vai ter gente própria —
--   VENDEDOR (frente de caixa do salão) e ENTREGADOR (moto-boy da Logística
--   0121). Antes das telas de cada um, nasce a BASE: o dono cadastra a pessoa
--   e escolhe a função. As telas (acesso só-rota do entregador = fatia C;
--   frente de caixa do vendedor) penduram nesta base nas próximas fatias.
--
-- Desenho: a IDENTIDADE reusa network.partner_people (porta única 0095 —
--   username único na rede por environment + senha scrypt). O VÍNCULO do
--   staff da matriz é esta tabela NOVA, separada dos parceiros DE PROPÓSITO:
--   a matriz não é um partner_units, e o CHECK de role dos vínculos de
--   parceiro (owner/funcionario) não é poluído com papéis da matriz.
--
-- SEGURANÇA (fatia 1 = superfície zero):
--   · pessoa criada aqui NÃO tem vínculo com loja → authenticatePersonGlobal
--     devolve null/401 (people.ts: "sem loja ativa = mesma cara de credencial
--     inválida") — colaborador cadastrado ainda NÃO loga em lugar nenhum.
--   · zero grant pro farejador_partner_app (default deny; provado no DO).
--   · partner_people já é zero-grant (0095) — nada muda pro lado do parceiro.
--
-- ADITIVA e sem flag (a aba vive no painel do dono, atrás de requireAdminAuth).
-- ─────────────────────────────────────────────
-- ROLLBACK (reverter o backend primeiro):
--   DROP TRIGGER env_match_matriz_collab_person ON network.matriz_collaborators;
--   DROP TRIGGER env_immutable_matriz_collaborators ON network.matriz_collaborators;
--   DROP TABLE network.matriz_collaborators;
--   (Pessoas criadas ficam órfãs em partner_people — inofensivas: sem vínculo
--    não logam; revogá-las libera o username.)
-- ─────────────────────────────────────────────
-- Assinatura: Orquestrador (Claude Fable 5) — banco/matriz, 2026-07-04

CREATE TABLE IF NOT EXISTS network.matriz_collaborators (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   env_t NOT NULL,
  person_id     UUID NOT NULL REFERENCES network.partner_people(id),
  display_name  TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 120),
  job           TEXT NOT NULL CHECK (job IN ('vendedor','entregador')),
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);

COMMENT ON TABLE network.matriz_collaborators IS
  '0124: colaborador da MATRIZ (vendedor do salão / entregador da Logística 0121). Vínculo do staff da matriz — identidade em network.partner_people (porta única 0095), papel aqui. Ativo = revoked_at IS NULL. Fatia 1 = só cadastro: pessoa sem vínculo de loja não loga (people.ts); as telas por função vêm nas próximas fatias. SÓ matriz — zero grant pro farejador_partner_app.';
COMMENT ON COLUMN network.matriz_collaborators.job IS
  '0124: função do colaborador — vendedor (frente de caixa) | entregador (rota 0121). Decide qual tela abre quando a fatia de login/telas existir.';

-- Uma pessoa só pode ser UM colaborador ativo da matriz (recadastrar exige revogar antes).
CREATE UNIQUE INDEX IF NOT EXISTS matriz_collaborators_person_uq
  ON network.matriz_collaborators (environment, person_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS matriz_collaborators_env_idx
  ON network.matriz_collaborators (environment, created_at DESC);

-- environment imutável + env do vínculo TEM de bater com o env da pessoa (padrão 0095).
DROP TRIGGER IF EXISTS env_immutable_matriz_collaborators ON network.matriz_collaborators;
CREATE TRIGGER env_immutable_matriz_collaborators
  BEFORE UPDATE OF environment ON network.matriz_collaborators
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_match_matriz_collab_person ON network.matriz_collaborators;
CREATE TRIGGER env_match_matriz_collab_person
  BEFORE INSERT OR UPDATE OF person_id ON network.matriz_collaborators
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partner_people', 'person_id');

-- PROVA (molde 0121): a tabela existe e o pool do parceiro NÃO alcança — senão a migration EXPLODE.
DO $$
DECLARE
  v_sel BOOLEAN;
  v_ins BOOLEAN;
BEGIN
  IF to_regclass('network.matriz_collaborators') IS NULL THEN
    RAISE EXCEPTION '0124 falhou: network.matriz_collaborators nao existe';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    SELECT has_table_privilege('farejador_partner_app', 'network.matriz_collaborators', 'SELECT') INTO v_sel;
    SELECT has_table_privilege('farejador_partner_app', 'network.matriz_collaborators', 'INSERT') INTO v_ins;
    IF v_sel OR v_ins THEN
      RAISE EXCEPTION '0124 falhou: farejador_partner_app NAO deveria acessar matriz_collaborators (select=%, insert=%)', v_sel, v_ins;
    END IF;
  END IF;

  RAISE NOTICE '0124 OK: colaboradores da matriz prontos (fatia cadastro); parceiro sem acesso.';
END $$;
