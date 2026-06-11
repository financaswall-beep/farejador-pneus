-- 0095: PORTA ÚNICA DE LOGIN — conta da PESSOA + vínculos (decisão do dono 2026-06-11).
--
-- HOJE (0086): o login usuário+senha vive POR UNIDADE em network.partner_access_tokens:
-- "wallace" do Rio do Ouro e "wallace" do Méier são linhas independentes, com senhas
-- independentes. A tela de login é por slug — não existe /login global.
--
-- ESTA MIGRATION cria o modelo dos multi-tenant grandes: a PESSOA
-- (network.partner_people) com username ÚNICO NA REDE (por environment, entre ativos)
-- e UMA senha; cada linha de partner_access_tokens vira um VÍNCULO (person_id) da
-- pessoa com a unidade (o papel owner/funcionario continua no vínculo, por unidade).
--
-- A porta única (/login) valida a PESSOA e lista os vínculos DELA: 1 → entra direto;
-- N → "escolhe a loja". Senha igual de OUTRA pessoa nunca mistura — a conta é outra.
-- (Furo do desenho antigo "mostra onde a senha bateu", morto aqui.)
--
-- BACKFILL (dados reais conferidos 2026-06-11 via scripts/checar-usernames-porta-unica.cjs):
--   - username SEM colisão → 1 pessoa por login (prod: caio, dono; test: wallace).
--   - colisão "wallace" em prod: 4 linhas, TODAS role='owner' = o próprio dono
--     (borracharia-rio-do-ouro + 3 zz-teste) → FUNDE numa pessoa; a senha da pessoa
--     é a MAIS RECENTE (login_password_set_at máximo = a da zz-teste-copacabana).
--   - REGRA DE SEGURANÇA da fusão: grupo com colisão só funde se TODAS as linhas
--     são role='owner' (dono com N lojas = mesma pessoa). Colisão envolvendo
--     funcionário NÃO funde (dois "carlos" podem ser pessoas distintas) — ficaria
--     person_id NULL (porta única não enxerga; login por slug segue). Hoje não
--     existe nenhum caso assim (conferido antes de escrever isto).
--   - ESPELHO DE VOLTA: após fundir, a senha da pessoa é gravada de volta nas
--     linhas dos vínculos (login_password_hash) — senão a loja aceitaria DUAS
--     senhas (a velha no caminho por slug, a nova na porta única). Com o espelho,
--     o login legado por slug fica correto SEM mudar uma linha de código.
--
-- GRANTS: nenhum. partner_people fica acessível só pela role postgres (pool admin),
-- mesmo regime de partner_access_tokens/partner_sessions. O pool restrito do portal
-- nunca toca aqui (default deny).
--
-- ADITIVA e retrocompatível: login por slug (0086) continua; person_id NULL = linha
-- não migrada (caso futuro de colisão ambígua) segue funcionando no caminho antigo.
--
-- ─────────────────────────────────────────────
-- ROLLBACK (reverter o backend primeiro; o código 0086 não lê nada disto):
--   DROP TRIGGER env_match_partner_tokens_person ON network.partner_access_tokens;
--   ALTER TABLE network.partner_access_tokens DROP COLUMN person_id;
--   DROP TRIGGER env_immutable_partner_people ON network.partner_people;
--   DROP TABLE network.partner_people;
--   (As senhas espelhadas no backfill NÃO são revertidas — a senha mais recente
--   de cada pessoa fundida passa a valer nas lojas dela; reverter senha = reset.)
-- ─────────────────────────────────────────────

-- ── 1. A pessoa (conta global da rede) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS network.partner_people (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  username        TEXT NOT NULL,
  password_hash   TEXT,
  password_set_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);

-- Username único NA REDE (por environment), só entre contas ativas — revogar
-- libera o nome (funcionário demitido não prende "carlos" pra sempre).
CREATE UNIQUE INDEX IF NOT EXISTS partner_people_username_uq
  ON network.partner_people (environment, lower(username))
  WHERE revoked_at IS NULL;

COMMENT ON TABLE network.partner_people IS
  'Conta da PESSOA na rede (porta única de login, 0095). username único por environment entre ativas; password_hash scrypt (formato scrypt:<salt>:<hash>, calculado no Node — banco nunca vê senha em texto). Vínculos com unidades = network.partner_access_tokens.person_id (papel por unidade). Acesso só via pool admin (role postgres); pool restrito do portal não tem GRANT.';

DROP TRIGGER IF EXISTS env_immutable_partner_people ON network.partner_people;
CREATE TRIGGER env_immutable_partner_people
  BEFORE UPDATE OF environment ON network.partner_people
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

-- ── 2. O vínculo pessoa↔unidade ──────────────────────────────────────────────
ALTER TABLE network.partner_access_tokens
  ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES network.partner_people(id);

COMMENT ON COLUMN network.partner_access_tokens.person_id IS
  'Conta da pessoa dona deste login (0095). NULL = linha pré-porta-única (login por slug segue). O papel (role) é DO VÍNCULO: a mesma pessoa pode ser owner numa unidade e funcionario noutra.';

CREATE INDEX IF NOT EXISTS partner_access_tokens_person_idx
  ON network.partner_access_tokens (person_id)
  WHERE person_id IS NOT NULL AND revoked_at IS NULL;

-- env do vínculo tem de bater com o env da pessoa (defesa em profundidade; a
-- function tolera person_id NULL — 0021).
DROP TRIGGER IF EXISTS env_match_partner_tokens_person ON network.partner_access_tokens;
CREATE TRIGGER env_match_partner_tokens_person
  BEFORE INSERT OR UPDATE OF person_id ON network.partner_access_tokens
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partner_people', 'person_id');

-- ── 3. Backfill: logins existentes viram pessoas (+ fusão segura) ────────────
-- Idempotente: só olha linhas com person_id IS NULL; re-rodar não duplica nada.
WITH ativos AS (
  SELECT pat.id, pat.environment,
         lower(pat.login_username) AS uname,
         pat.login_username        AS uname_raw,
         pat.login_password_hash,
         pat.login_password_set_at,
         pat.role
    FROM network.partner_access_tokens pat
   WHERE pat.login_username IS NOT NULL
     AND pat.revoked_at IS NULL
     AND pat.person_id IS NULL
),
grupos AS (
  SELECT environment, uname,
         COUNT(*)                  AS n,
         bool_and(role = 'owner')  AS all_owner
    FROM ativos
   GROUP BY 1, 2
),
fundiveis AS (
  -- sem colisão, OU colisão 100% dono (mesma pessoa com N lojas — caso real: wallace×4)
  SELECT environment, uname FROM grupos WHERE n = 1 OR all_owner
),
pessoa_nova AS (
  INSERT INTO network.partner_people (environment, username, password_hash, password_set_at)
  SELECT a.environment,
         (array_agg(a.uname_raw            ORDER BY a.login_password_set_at DESC NULLS LAST))[1],
         (array_agg(a.login_password_hash  ORDER BY a.login_password_set_at DESC NULLS LAST))[1],
         max(a.login_password_set_at)
    FROM ativos a
    JOIN fundiveis f ON f.environment = a.environment AND f.uname = a.uname
   GROUP BY a.environment, a.uname
  RETURNING id, environment, lower(username) AS uname
)
UPDATE network.partner_access_tokens pat
   SET person_id = pn.id
  FROM pessoa_nova pn
 WHERE pat.environment = pn.environment
   AND lower(pat.login_username) = pn.uname
   AND pat.login_username IS NOT NULL
   AND pat.revoked_at IS NULL
   AND pat.person_id IS NULL;

-- ── 4. Espelho de volta: UMA senha por pessoa, em todos os vínculos ──────────
-- Mata as senhas antigas das outras lojas da pessoa fundida (a linha passa a
-- carregar o MESMO hash da pessoa). O login por slug (0086) lê a linha — fica
-- automaticamente coerente com a porta única, sem mudança de código no legado.
UPDATE network.partner_access_tokens pat
   SET login_password_hash   = pp.password_hash,
       login_password_set_at = pp.password_set_at
  FROM network.partner_people pp
 WHERE pat.person_id = pp.id
   AND pat.revoked_at IS NULL
   AND pat.login_password_hash IS DISTINCT FROM pp.password_hash;
