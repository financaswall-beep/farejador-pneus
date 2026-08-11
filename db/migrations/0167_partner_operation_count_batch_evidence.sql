-- 0167 - Corrige o solicitante da Operacao da Loja e amplia a contagem fisica.
--
-- A 0166 reutilizou ops.validate_env_match para conferir o token do funcionario.
-- Essa funcao e SECURITY INVOKER, mas a role farejador_partner_app nao pode ler
-- network.partner_access_tokens. O resultado era permission denied em toda
-- solicitacao valida. A funcao dedicada abaixo preserva o isolamento sem abrir
-- SELECT na tabela de credenciais.
--
-- A mesma obra adiciona um identificador de lote, detalhe do motivo e uma foto
-- opcional por item. A foto fica separada da fila principal para nao pesar nas
-- consultas do dono.

ALTER TABLE commerce.partner_stock_count_requests
  ADD COLUMN IF NOT EXISTS batch_id UUID;

ALTER TABLE commerce.partner_stock_count_requests
  ADD COLUMN IF NOT EXISTS reason_detail TEXT;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'partner_stock_count_reason_detail_length'
       AND conrelid = 'commerce.partner_stock_count_requests'::regclass
  ) THEN
    ALTER TABLE commerce.partner_stock_count_requests
      ADD CONSTRAINT partner_stock_count_reason_detail_length
      CHECK (reason_detail IS NULL OR length(reason_detail) <= 300);
  END IF;
END;
$constraints$;

CREATE INDEX IF NOT EXISTS partner_stock_count_pending_batch_idx
  ON commerce.partner_stock_count_requests(environment, unit_id, batch_id, created_at)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION ops.validate_partner_operation_request_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, network
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM network.partner_access_tokens pat
      JOIN network.partner_units pu
        ON pu.id = pat.partner_unit_id
       AND pu.environment = pat.environment
     WHERE pat.id = NEW.requested_by_token_id
       AND pat.environment = NEW.environment
       AND pat.revoked_at IS NULL
       AND pu.environment = NEW.environment
       AND pu.unit_id = NEW.unit_id
       AND pu.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'partner_request_actor_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ops.validate_partner_operation_request_actor IS
  '0167: valida token, ambiente e unidade das solicitacoes da Operacao da Loja sem conceder SELECT nas credenciais.';

REVOKE ALL ON FUNCTION ops.validate_partner_operation_request_actor() FROM PUBLIC;

DO $function_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    GRANT EXECUTE ON FUNCTION ops.validate_partner_operation_request_actor()
      TO farejador_partner_app;
  END IF;
END;
$function_grant$;

DROP TRIGGER IF EXISTS env_match_partner_item_registration_token
  ON commerce.partner_item_registration_requests;
DROP TRIGGER IF EXISTS actor_scope_partner_item_registration
  ON commerce.partner_item_registration_requests;
CREATE TRIGGER actor_scope_partner_item_registration
  BEFORE INSERT OR UPDATE OF environment, unit_id, requested_by_token_id
  ON commerce.partner_item_registration_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_partner_operation_request_actor();

DROP TRIGGER IF EXISTS env_match_partner_stock_count_token
  ON commerce.partner_stock_count_requests;
DROP TRIGGER IF EXISTS actor_scope_partner_stock_count
  ON commerce.partner_stock_count_requests;
CREATE TRIGGER actor_scope_partner_stock_count
  BEFORE INSERT OR UPDATE OF environment, unit_id, requested_by_token_id
  ON commerce.partner_stock_count_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_partner_operation_request_actor();

CREATE TABLE IF NOT EXISTS commerce.partner_stock_count_evidence (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment      env_t NOT NULL,
  unit_id           UUID NOT NULL REFERENCES core.units(id),
  request_id        UUID NOT NULL UNIQUE
                    REFERENCES commerce.partner_stock_count_requests(id) ON DELETE CASCADE,
  photo_bytes       BYTEA NOT NULL,
  photo_mime        TEXT NOT NULL CHECK (photo_mime = 'image/jpeg'),
  photo_size_bytes  INTEGER NOT NULL CHECK (photo_size_bytes > 0 AND photo_size_bytes <= 4194304),
  photo_sha256      TEXT NOT NULL CHECK (photo_sha256 ~ '^[0-9a-f]{64}$'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_stock_count_evidence_size_match
    CHECK (octet_length(photo_bytes) = photo_size_bytes)
);

DROP TRIGGER IF EXISTS env_match_partner_stock_count_evidence_unit
  ON commerce.partner_stock_count_evidence;
CREATE TRIGGER env_match_partner_stock_count_evidence_unit
  BEFORE INSERT OR UPDATE OF unit_id ON commerce.partner_stock_count_evidence
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

DROP TRIGGER IF EXISTS env_match_partner_stock_count_evidence_request
  ON commerce.partner_stock_count_evidence;
CREATE TRIGGER env_match_partner_stock_count_evidence_request
  BEFORE INSERT OR UPDATE OF request_id ON commerce.partner_stock_count_evidence
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'commerce', 'partner_stock_count_requests', 'request_id'
  );

DROP TRIGGER IF EXISTS env_immutable_partner_stock_count_evidence
  ON commerce.partner_stock_count_evidence;
CREATE TRIGGER env_immutable_partner_stock_count_evidence
  BEFORE UPDATE OF environment ON commerce.partner_stock_count_evidence
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

ALTER TABLE commerce.partner_stock_count_evidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_stock_count_evidence_isolation
  ON commerce.partner_stock_count_evidence;
CREATE POLICY partner_stock_count_evidence_isolation
  ON commerce.partner_stock_count_evidence
  FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL
         AND unit_id = network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL
              AND unit_id = network.current_partner_core_unit());

REVOKE ALL ON commerce.partner_stock_count_evidence FROM PUBLIC;

DO $table_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    GRANT SELECT, INSERT ON commerce.partner_stock_count_evidence
      TO farejador_partner_app;
    REVOKE UPDATE, DELETE ON commerce.partner_stock_count_evidence
      FROM farejador_partner_app;
  END IF;
END;
$table_grants$;

COMMENT ON TABLE commerce.partner_stock_count_evidence IS
  '0167: foto JPEG opcional de uma contagem fisica; isolada por unidade e fora da consulta principal.';

DO $smoke$
DECLARE
  v_security_definer BOOLEAN;
  v_rls BOOLEAN;
BEGIN
  SELECT p.prosecdef INTO v_security_definer
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops'
     AND p.proname = 'validate_partner_operation_request_actor';
  IF v_security_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0167: validador do solicitante nao e SECURITY DEFINER';
  END IF;

  SELECT relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'commerce' AND c.relname = 'partner_stock_count_evidence';
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0167: RLS ausente em partner_stock_count_evidence';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app')
     AND has_table_privilege(
       'farejador_partner_app', 'network.partner_access_tokens', 'SELECT'
     ) THEN
    RAISE EXCEPTION '0167: role restrita recebeu SELECT nas credenciais';
  END IF;
END;
$smoke$;
