-- 0085: Etapa 4 (níveis dono/funcionário) — expõe o `role` do token no login.
--
-- A coluna network.partner_access_tokens.role já existe (0083, default 'owner',
-- CHECK in ('owner','funcionario')). Mas a função de login
-- network.validate_partner_token NÃO devolvia o role — então a aplicação não
-- sabia se quem logou é dono ou funcionário. Esta migration adiciona a coluna
-- `role` ao retorno da função.
--
-- Como muda as COLUNAS DE RETORNO (não a assinatura de argumentos), o Postgres
-- não permite CREATE OR REPLACE: é preciso DROP + CREATE. Ao dropar, o GRANT
-- some junto — por isso re-aplicamos REVOKE FROM PUBLIC + GRANT EXECUTE pra
-- farejador_partner_app no fim (idêntico ao 0044).
--
-- Tudo o mais (search_path restrito, hash inline sha256, SECURITY DEFINER,
-- last_used_at) é preservado IDÊNTICO ao 0044. Tokens existentes continuam
-- válidos. Tokens antigos sem role explícito já têm 'owner' por default (0083).
--
-- ─────────────────────────────────────────────
-- ROLLBACK (se precisar voltar): recriar a função SEM a coluna role, copiando
-- a definição original do 0044 (linhas 82-148). A aplicação tolera o role
-- ausente? NÃO depois do deploy do backend — então o rollback é: reverter o
-- backend primeiro, depois recriar a função antiga. Snapshot da def antiga
-- guardado em docs (handoff Etapa 4).
-- ─────────────────────────────────────────────

DROP FUNCTION IF EXISTS network.validate_partner_token(TEXT, TEXT, TEXT);

CREATE FUNCTION network.validate_partner_token(
  p_environment TEXT,
  p_slug        TEXT,
  p_token       TEXT
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
-- search_path RESTRITO igual ao 0044: pg_catalog (builtins) + network. Sem
-- 'public'/'extensions'. Hash calculado INLINE via sha256() do pg_catalog.
SET search_path = pg_catalog, network
AS $$
DECLARE
  v_hash TEXT;
BEGIN
  v_hash := encode(sha256(p_token::bytea), 'hex');

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
  FROM network.partner_units pu
  JOIN network.partners p
    ON p.id = pu.partner_id AND p.environment = pu.environment
  JOIN network.partner_access_tokens pat
    ON pat.partner_unit_id = pu.id AND pat.environment = pu.environment
  WHERE pu.environment = p_environment
    AND pu.slug = p_slug
    AND pu.status = 'active'
    AND p.status = 'active'
    AND pu.deleted_at IS NULL
    AND p.deleted_at IS NULL
    AND pat.revoked_at IS NULL
    AND pat.token_hash = v_hash
  LIMIT 1;

  IF FOUND THEN
    UPDATE network.partner_access_tokens
    SET last_used_at = now()
    WHERE token_hash = v_hash
      AND environment = p_environment
      AND revoked_at IS NULL;
  END IF;
END;
$$;

COMMENT ON FUNCTION network.validate_partner_token IS
  'Valida token de parceiro e devolve contexto + role (owner/funcionario). SECURITY DEFINER permite role restrita validar sem SELECT direto em partner_access_tokens. EXECUTE so para farejador_partner_app (PUBLIC revogado). search_path restrito pra prevenir injection. role adicionado na 0085 (Etapa 4).';

-- Re-aplica o controle de acesso à função (o DROP removeu o GRANT do 0044).
REVOKE ALL    ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT) TO farejador_partner_app;
