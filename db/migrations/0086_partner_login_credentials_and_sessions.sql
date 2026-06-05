-- 0086: Login de verdade do parceiro (usuário + senha) — Etapa P1.
--
-- HOJE: dono e funcionário entram colando o token de ~48 chars (hash sha256,
-- guardado só como hash desde a 0044). É tosco pro funcionário (cola na mão,
-- troca de aparelho = cola de novo) e não tem "esqueci a senha".
--
-- ESTA MIGRATION troca a porta de entrada por usuário+senha, SEM enfraquecer a
-- segurança do token:
--   1. Credenciais no login: cada token de acesso ganha login_username +
--      login_password_hash (hash scrypt calculado no Node — o banco guarda só o
--      hash, igual ao token). O token cru vira CHAVE DE PRIMEIRO ACESSO do dono.
--   2. Sessões: login confere a senha e emite um TOKEN DE SESSÃO descartável
--      (com validade). O navegador passa a usar a sessão no lugar do token cru.
--      A sessão também é guardada só como hash sha256 (mesmo padrão do token).
--
-- POR QUE SESSÃO (e não "devolver o token"): o token só existe como hash no
-- banco — o servidor NÃO tem o texto pra devolver depois do primeiro acesso.
-- Logo, login com senha precisa emitir credencial nova (a sessão).
--
-- COMO OS DOIS PERFIS GANHAM SENHA:
--   - 👑 Dono: primeiro acesso cola o token (uma vez) e escolhe usuário+senha.
--     Vale pros donos novos e pros que já existem. A matriz NUNCA vê a senha.
--   - 👷 Funcionário: o dono define usuário+senha ao criar o login (não toca em
--     token) e pode resetar a senha. (App-side, via pool admin.)
--
-- ADITIVA e retrocompatível: tokens existentes continuam válidos (o login por
-- token segue funcionando como bootstrap/fallback). Nada quebra ao aplicar cedo.
--
-- ─────────────────────────────────────────────
-- ROLLBACK: DROP da função validate_partner_session; DROP da tabela
-- partner_sessions; DROP das colunas login_* e do índice único de username.
-- O backend tolera a ausência? Só ANTES do deploy do backend novo — então o
-- rollback é reverter o backend primeiro, depois esta migration.
-- ─────────────────────────────────────────────

-- ── 1. Credenciais de login no token de acesso ──────────────────────────────
-- O token de acesso é a "conta": cada um (dono ou funcionário) é uma linha.
-- login_username é único por unidade (a tela de login é por slug/unidade), só
-- entre logins ativos (ignora revogados e nulos).
ALTER TABLE network.partner_access_tokens
  ADD COLUMN IF NOT EXISTS login_username        TEXT,
  ADD COLUMN IF NOT EXISTS login_password_hash   TEXT,
  ADD COLUMN IF NOT EXISTS login_password_set_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS partner_access_tokens_username_uq
  ON network.partner_access_tokens (environment, partner_unit_id, lower(login_username))
  WHERE login_username IS NOT NULL AND revoked_at IS NULL;

COMMENT ON COLUMN network.partner_access_tokens.login_username IS
  'Usuário do login (P1, 0086). Único por unidade entre logins ativos. NULL = login ainda só por token (dono antes do 1º acesso).';
COMMENT ON COLUMN network.partner_access_tokens.login_password_hash IS
  'Hash scrypt da senha (calculado no Node, formato scrypt:<saltHex>:<hashHex>). Banco nunca vê a senha em texto.';

-- ── 2. Sessões emitidas no login ────────────────────────────────────────────
-- Uma sessão pertence a UM token de acesso (token_id) → carrega o papel
-- (owner/funcionario) e a unidade. Se o dono revogar o login do funcionário,
-- a sessão morre junto (o validate exige pat.revoked_at IS NULL).
-- session_hash = sha256 do token de sessão (mesmo esquema do token de acesso).
CREATE TABLE IF NOT EXISTS network.partner_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment    env_t NOT NULL,
  token_id       UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  session_hash   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  UNIQUE (environment, session_hash)
);

CREATE INDEX IF NOT EXISTS partner_sessions_token_idx
  ON network.partner_sessions(token_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE network.partner_sessions IS
  'Sessões do portal parceiro (P1, 0086). Emitidas no login por usuário+senha. session_hash = sha256 do token de sessão (guardado só como hash). Ligada ao token de acesso (token_id) → herda papel e unidade; revogar o token mata a sessão.';

-- env da sessão tem de bater com o env do token de acesso (defesa em profundidade).
DROP TRIGGER IF EXISTS env_match_partner_sessions_token ON network.partner_sessions;
CREATE TRIGGER env_match_partner_sessions_token
  BEFORE INSERT OR UPDATE OF token_id ON network.partner_sessions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partner_access_tokens', 'token_id');

DROP TRIGGER IF EXISTS env_immutable_partner_sessions ON network.partner_sessions;
CREATE TRIGGER env_immutable_partner_sessions
  BEFORE UPDATE OF environment ON network.partner_sessions
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

-- ── 3. Validação da sessão (chamada pelo pool RESTRITO em todo request) ──────
-- SECURITY DEFINER igual a validate_partner_token: a role 'farejador_partner_app'
-- NÃO tem SELECT em partner_sessions nem em partner_access_tokens — só EXECUTE
-- nesta função. Devolve o MESMO contexto de validate_partner_token (mesma forma),
-- pra auth.ts tratar sessão e token pelo mesmo caminho.
-- search_path RESTRITO (pg_catalog, network), hash inline sha256 (sem pgcrypto).
CREATE OR REPLACE FUNCTION network.validate_partner_session(
  p_environment TEXT,
  p_slug        TEXT,
  p_session     TEXT
) RETURNS TABLE (
  partner_unit_id  UUID,
  unit_id          UUID,
  partner_id       UUID,
  slug             TEXT,
  partner_name     TEXT,
  unit_name        TEXT,
  token_id         UUID,
  role             TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, network
AS $$
DECLARE
  v_hash TEXT;
BEGIN
  v_hash := encode(sha256(p_session::bytea), 'hex');

  RETURN QUERY
  SELECT
    pu.id           AS partner_unit_id,
    pu.unit_id,
    p.id            AS partner_id,
    pu.slug,
    p.trade_name    AS partner_name,
    pu.display_name AS unit_name,
    pat.id          AS token_id,
    pat.role        AS role
  FROM network.partner_sessions ps
  JOIN network.partner_access_tokens pat
    ON pat.id = ps.token_id AND pat.environment = ps.environment
  JOIN network.partner_units pu
    ON pu.id = pat.partner_unit_id AND pu.environment = pat.environment
  JOIN network.partners p
    ON p.id = pu.partner_id AND p.environment = pu.environment
  WHERE ps.environment = p_environment
    AND pu.slug = p_slug
    AND pu.status = 'active'
    AND p.status = 'active'
    AND pu.deleted_at IS NULL
    AND p.deleted_at IS NULL
    AND pat.revoked_at IS NULL
    AND ps.revoked_at IS NULL
    AND ps.expires_at > now()
    AND ps.session_hash = v_hash
  LIMIT 1;

  IF FOUND THEN
    UPDATE network.partner_sessions
    SET last_used_at = now()
    WHERE session_hash = v_hash
      AND environment = p_environment
      AND revoked_at IS NULL;
  END IF;
END;
$$;

COMMENT ON FUNCTION network.validate_partner_session IS
  'Valida token de sessão do parceiro e devolve contexto + role (mesma forma de validate_partner_token). SECURITY DEFINER: role restrita valida sem SELECT direto em partner_sessions/partner_access_tokens. EXECUTE só para farejador_partner_app. P1 (0086).';

REVOKE ALL    ON FUNCTION network.validate_partner_session(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network.validate_partner_session(TEXT, TEXT, TEXT) TO farejador_partner_app;
