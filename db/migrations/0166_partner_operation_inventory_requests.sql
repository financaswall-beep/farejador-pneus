-- 0166 - Estoque seguro na Operacao da Loja (mobile).
--
-- O funcionario pode consultar o estoque oficial, mas suas duas escritas sao
-- solicitacoes: cadastro sem preco/custo/saldo e contagem sem ajuste automatico.
-- A aprovacao do dono completa custo/preco/saldo ou aplica a contagem numa
-- transacao auditada. Item incompleto nunca aparece no PDV por R$ 0.

CREATE TABLE IF NOT EXISTS commerce.partner_item_registration_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment           env_t NOT NULL,
  unit_id                UUID NOT NULL REFERENCES core.units(id),
  requested_by_token_id UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  requested_by_label    TEXT NOT NULL,
  item_type              TEXT NOT NULL CHECK (item_type IN ('pneu', 'insumo', 'servico')),
  local_sku              TEXT,
  item_name              TEXT NOT NULL,
  tire_size              TEXT,
  tire_width_mm          INTEGER CHECK (tire_width_mm IS NULL OR tire_width_mm BETWEEN 1 AND 999),
  tire_aspect_ratio      INTEGER CHECK (tire_aspect_ratio IS NULL OR tire_aspect_ratio BETWEEN 1 AND 999),
  tire_rim_diameter      INTEGER CHECK (tire_rim_diameter IS NULL OR tire_rim_diameter BETWEEN 1 AND 30),
  brand                  TEXT,
  minimum_quantity       INTEGER CHECK (minimum_quantity IS NULL OR minimum_quantity >= 0),
  tire_condition         TEXT CHECK (tire_condition IS NULL OR tire_condition IN ('meia_vida', 'novo', 'remold')),
  shelf_location         TEXT,
  tire_position          TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  idempotency_key        TEXT NOT NULL,
  reviewed_by            TEXT,
  reviewed_at            TIMESTAMPTZ,
  review_reason          TEXT,
  approved_stock_id      UUID REFERENCES commerce.partner_stock_levels(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_item_registration_tire_fields_check CHECK (
    item_type <> 'pneu' OR (
      tire_width_mm IS NOT NULL AND tire_aspect_ratio IS NOT NULL
      AND tire_rim_diameter IS NOT NULL AND tire_condition IS NOT NULL
    )
  ),
  CONSTRAINT partner_item_registration_service_fields_check CHECK (
    item_type <> 'servico' OR (
      tire_size IS NULL AND tire_width_mm IS NULL AND tire_aspect_ratio IS NULL
      AND tire_rim_diameter IS NULL AND tire_condition IS NULL
      AND shelf_location IS NULL AND tire_position IS NULL
      AND minimum_quantity IS NULL
    )
  ),
  UNIQUE (environment, unit_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS partner_item_registration_pending_idx
  ON commerce.partner_item_registration_requests(environment, unit_id, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS commerce.partner_stock_count_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment           env_t NOT NULL,
  unit_id                UUID NOT NULL REFERENCES core.units(id),
  stock_id               UUID NOT NULL REFERENCES commerce.partner_stock_levels(id),
  requested_by_token_id UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  requested_by_label    TEXT NOT NULL,
  quantity_snapshot     INTEGER CHECK (quantity_snapshot IS NULL OR quantity_snapshot >= 0),
  stock_updated_at_snapshot TIMESTAMPTZ NOT NULL,
  counted_quantity      INTEGER NOT NULL CHECK (counted_quantity >= 0),
  reason                 TEXT NOT NULL CHECK (reason IN ('rotina', 'inventario', 'divergencia', 'outro')),
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  idempotency_key        TEXT NOT NULL,
  reviewed_by            TEXT,
  reviewed_at            TIMESTAMPTZ,
  review_reason          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, unit_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS partner_stock_count_pending_idx
  ON commerce.partner_stock_count_requests(environment, unit_id, created_at DESC)
  WHERE status = 'pending';

DROP TRIGGER IF EXISTS partner_item_registration_updated_at
  ON commerce.partner_item_registration_requests;
CREATE TRIGGER partner_item_registration_updated_at
  BEFORE UPDATE ON commerce.partner_item_registration_requests
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS partner_stock_count_updated_at
  ON commerce.partner_stock_count_requests;
CREATE TRIGGER partner_stock_count_updated_at
  BEFORE UPDATE ON commerce.partner_stock_count_requests
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS env_match_partner_item_registration_unit
  ON commerce.partner_item_registration_requests;
CREATE TRIGGER env_match_partner_item_registration_unit
  BEFORE INSERT OR UPDATE OF unit_id ON commerce.partner_item_registration_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

DROP TRIGGER IF EXISTS env_match_partner_item_registration_token
  ON commerce.partner_item_registration_requests;
CREATE TRIGGER env_match_partner_item_registration_token
  BEFORE INSERT OR UPDATE OF requested_by_token_id ON commerce.partner_item_registration_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partner_access_tokens', 'requested_by_token_id');

DROP TRIGGER IF EXISTS env_match_partner_item_registration_stock
  ON commerce.partner_item_registration_requests;
CREATE TRIGGER env_match_partner_item_registration_stock
  BEFORE INSERT OR UPDATE OF approved_stock_id ON commerce.partner_item_registration_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'partner_stock_levels', 'approved_stock_id');

DROP TRIGGER IF EXISTS env_match_partner_stock_count_unit
  ON commerce.partner_stock_count_requests;
CREATE TRIGGER env_match_partner_stock_count_unit
  BEFORE INSERT OR UPDATE OF unit_id ON commerce.partner_stock_count_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

DROP TRIGGER IF EXISTS env_match_partner_stock_count_stock
  ON commerce.partner_stock_count_requests;
CREATE TRIGGER env_match_partner_stock_count_stock
  BEFORE INSERT OR UPDATE OF stock_id ON commerce.partner_stock_count_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'partner_stock_levels', 'stock_id');

DROP TRIGGER IF EXISTS env_match_partner_stock_count_token
  ON commerce.partner_stock_count_requests;
CREATE TRIGGER env_match_partner_stock_count_token
  BEFORE INSERT OR UPDATE OF requested_by_token_id ON commerce.partner_stock_count_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network', 'partner_access_tokens', 'requested_by_token_id');

DROP TRIGGER IF EXISTS env_immutable_partner_item_registration
  ON commerce.partner_item_registration_requests;
CREATE TRIGGER env_immutable_partner_item_registration
  BEFORE UPDATE OF environment ON commerce.partner_item_registration_requests
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_partner_stock_count
  ON commerce.partner_stock_count_requests;
CREATE TRIGGER env_immutable_partner_stock_count
  BEFORE UPDATE OF environment ON commerce.partner_stock_count_requests
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

ALTER TABLE commerce.partner_item_registration_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_stock_count_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_item_registration_isolation
  ON commerce.partner_item_registration_requests;
CREATE POLICY partner_item_registration_isolation
  ON commerce.partner_item_registration_requests
  FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL
         AND unit_id = network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL
              AND unit_id = network.current_partner_core_unit());

DROP POLICY IF EXISTS partner_stock_count_isolation
  ON commerce.partner_stock_count_requests;
CREATE POLICY partner_stock_count_isolation
  ON commerce.partner_stock_count_requests
  FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL
         AND unit_id = network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL
              AND unit_id = network.current_partner_core_unit());

REVOKE ALL ON commerce.partner_item_registration_requests FROM PUBLIC;
REVOKE ALL ON commerce.partner_stock_count_requests FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    GRANT SELECT, INSERT ON commerce.partner_item_registration_requests
      TO farejador_partner_app;
    GRANT SELECT, INSERT ON commerce.partner_stock_count_requests
      TO farejador_partner_app;
    REVOKE UPDATE, DELETE ON commerce.partner_item_registration_requests
      FROM farejador_partner_app;
    REVOKE UPDATE, DELETE ON commerce.partner_stock_count_requests
      FROM farejador_partner_app;
  END IF;
END;
$grants$;

COMMENT ON TABLE commerce.partner_item_registration_requests IS
  '0166: cadastro operacional sem custo, preco ou saldo; o dono completa e aprova.';
COMMENT ON TABLE commerce.partner_stock_count_requests IS
  '0166: contagem fisica; so o dono aplica com trava contra snapshot obsoleto.';

DO $smoke$
DECLARE
  v_write_grants INTEGER;
  v_rls BOOLEAN;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'commerce' AND c.relname = 'partner_item_registration_requests';
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0166: RLS ausente em partner_item_registration_requests';
  END IF;

  SELECT relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'commerce' AND c.relname = 'partner_stock_count_requests';
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0166: RLS ausente em partner_stock_count_requests';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    SELECT count(*) INTO v_write_grants
      FROM information_schema.role_table_grants
     WHERE grantee = 'farejador_partner_app'
       AND table_schema = 'commerce'
       AND table_name IN ('partner_item_registration_requests', 'partner_stock_count_requests')
       AND privilege_type IN ('UPDATE', 'DELETE');
    IF v_write_grants <> 0 THEN
      RAISE EXCEPTION '0166: role do parceiro recebeu UPDATE/DELETE nas solicitacoes';
    END IF;
  END IF;
END;
$smoke$;
