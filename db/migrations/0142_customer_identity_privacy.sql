-- ============================================================
-- 0142_customer_identity_privacy.sql
-- Etapa 9: sobreposicao canonica de clientes + trilha de privacidade.
--
-- ADITIVA E DORMENTE:
--   * nao altera as quatro fontes atuais de cliente;
--   * nao copia nome, telefone, CPF, e-mail ou endereco;
--   * nao executa anonimizacao nem cria cron de retencao;
--   * nenhuma tabela e concedida ao portal parceiro.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS commerce.customer_identities (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment                env_t NOT NULL,
  entity_type                TEXT NOT NULL DEFAULT 'unknown'
                             CHECK (entity_type IN ('person','organization','fleet','tire_shop','partner','collaborator','unknown')),
  status                     TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','merged','anonymized')),
  classification             TEXT,
  is_vip                     BOOLEAN NOT NULL DEFAULT false,
  type_source_link_id        UUID,
  classification_source_link_id UUID,
  vip_source_link_id         UUID,
  superseded_by              UUID REFERENCES commerce.customer_identities(id),
  decision_actor             TEXT,
  decision_reason            TEXT,
  decided_at                 TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'merged') = (superseded_by IS NOT NULL)),
  CHECK (superseded_by IS NULL OR superseded_by <> id)
);

CREATE INDEX IF NOT EXISTS customer_identities_env_status_idx
  ON commerce.customer_identities(environment, status, created_at, id);

CREATE TABLE IF NOT EXISTS commerce.customer_identity_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  identity_id     UUID NOT NULL REFERENCES commerce.customer_identities(id),
  source_type     TEXT NOT NULL CHECK (source_type IN (
                    'chatwoot_contact','walkin_customer','partner_customer',
                    'wholesale_customer','network_partner','matriz_collaborator'
                  )),
  source_id       UUID NOT NULL,
  owner_scope     TEXT NOT NULL CHECK (owner_scope IN ('matrix','partner_unit')),
  partner_unit_id UUID REFERENCES network.partner_units(id),
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_by       TEXT NOT NULL,
  link_reason     TEXT NOT NULL,
  ended_at        TIMESTAMPTZ,
  ended_by        TEXT,
  end_reason      TEXT,
  CHECK ((owner_scope = 'partner_unit') = (partner_unit_id IS NOT NULL)),
  CHECK ((ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL)
      OR (ended_at IS NOT NULL AND ended_by IS NOT NULL AND end_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_identity_links_active_source_uq
  ON commerce.customer_identity_links(environment, source_type, source_id)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_identity_links_identity_idx
  ON commerce.customer_identity_links(environment, identity_id)
  WHERE ended_at IS NULL;

ALTER TABLE commerce.customer_identities
  DROP CONSTRAINT IF EXISTS customer_identities_type_source_link_fk,
  DROP CONSTRAINT IF EXISTS customer_identities_classification_source_link_fk,
  DROP CONSTRAINT IF EXISTS customer_identities_vip_source_link_fk;
ALTER TABLE commerce.customer_identities
  ADD CONSTRAINT customer_identities_type_source_link_fk
    FOREIGN KEY (type_source_link_id) REFERENCES commerce.customer_identity_links(id),
  ADD CONSTRAINT customer_identities_classification_source_link_fk
    FOREIGN KEY (classification_source_link_id) REFERENCES commerce.customer_identity_links(id),
  ADD CONSTRAINT customer_identities_vip_source_link_fk
    FOREIGN KEY (vip_source_link_id) REFERENCES commerce.customer_identity_links(id);

CREATE TABLE IF NOT EXISTS commerce.customer_identity_candidates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  left_link_id    UUID NOT NULL REFERENCES commerce.customer_identity_links(id),
  right_link_id   UUID NOT NULL REFERENCES commerce.customer_identity_links(id),
  signal          TEXT NOT NULL CHECK (signal IN ('exact_normalized_phone','explicit_foreign_key','manual')),
  score           NUMERIC(5,4) NOT NULL CHECK (score >= 0 AND score <= 1),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by      TEXT,
  decision_reason TEXT,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (left_link_id::text < right_link_id::text),
  CHECK ((status = 'pending' AND decided_by IS NULL AND decision_reason IS NULL AND decided_at IS NULL)
      OR (status <> 'pending' AND decided_by IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL)),
  UNIQUE (environment, left_link_id, right_link_id, signal)
);

CREATE INDEX IF NOT EXISTS customer_identity_candidates_queue_idx
  ON commerce.customer_identity_candidates(environment, status, created_at, id);

CREATE TABLE IF NOT EXISTS ops.privacy_requests (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment              env_t NOT NULL,
  identity_id              UUID NOT NULL REFERENCES commerce.customer_identities(id),
  request_type             TEXT NOT NULL CHECK (request_type IN ('portability','anonymization')),
  status                   TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
                             'requested','identity_verified','scope_ready','approved',
                             'executing','completed','partially_completed','rejected'
                           )),
  idempotency_key          TEXT NOT NULL,
  request_fingerprint      TEXT NOT NULL,
  verification_method      TEXT,
  verification_result      TEXT CHECK (verification_result IN ('passed','failed') OR verification_result IS NULL),
  verification_operator    TEXT,
  verified_at              TIMESTAMPTZ,
  approved_by              TEXT,
  approval_reason          TEXT,
  approved_at              TIMESTAMPTZ,
  legal_hold               BOOLEAN NOT NULL DEFAULT false,
  pending_scopes           TEXT[] NOT NULL DEFAULT '{}',
  result_summary           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by               TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ,
  UNIQUE (environment, idempotency_key),
  CHECK ((verification_method IS NULL AND verification_result IS NULL AND verification_operator IS NULL AND verified_at IS NULL)
      OR (verification_method IS NOT NULL AND verification_result IS NOT NULL AND verification_operator IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS privacy_requests_identity_idx
  ON ops.privacy_requests(environment, identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS privacy_requests_status_idx
  ON ops.privacy_requests(environment, status, created_at, id);

CREATE TABLE IF NOT EXISTS ops.privacy_request_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment        env_t NOT NULL,
  privacy_request_id UUID NOT NULL REFERENCES ops.privacy_requests(id),
  event_type         TEXT NOT NULL,
  actor_label        TEXT NOT NULL,
  status_before      TEXT,
  status_after       TEXT,
  details            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS privacy_request_events_request_idx
  ON ops.privacy_request_events(environment, privacy_request_id, created_at, id);

CREATE OR REPLACE FUNCTION commerce.validate_customer_identity_link()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_env env_t;
  v_partner_unit UUID;
BEGIN
  SELECT environment INTO v_env FROM commerce.customer_identities WHERE id = NEW.identity_id;
  IF v_env IS NULL OR v_env <> NEW.environment THEN
    RAISE EXCEPTION 'customer_identity_link_environment_mismatch' USING ERRCODE = '23514';
  END IF;

  CASE NEW.source_type
    WHEN 'chatwoot_contact' THEN
      SELECT environment INTO v_env FROM core.contacts WHERE id = NEW.source_id;
    WHEN 'walkin_customer' THEN
      SELECT environment INTO v_env FROM commerce.customers WHERE id = NEW.source_id;
    WHEN 'partner_customer' THEN
      SELECT pc.environment, pu.id INTO v_env, v_partner_unit
        FROM commerce.partner_customers pc
        JOIN network.partner_units pu
          ON pu.environment = pc.environment AND pu.unit_id = pc.unit_id AND pu.deleted_at IS NULL
       WHERE pc.id = NEW.source_id;
    WHEN 'wholesale_customer' THEN
      SELECT environment INTO v_env FROM commerce.wholesale_customers WHERE id = NEW.source_id;
    WHEN 'network_partner' THEN
      SELECT environment INTO v_env FROM network.partners WHERE id = NEW.source_id;
    WHEN 'matriz_collaborator' THEN
      SELECT environment INTO v_env FROM network.matriz_collaborators WHERE id = NEW.source_id;
  END CASE;

  IF v_env IS NULL THEN
    RAISE EXCEPTION 'customer_identity_source_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_env <> NEW.environment THEN
    RAISE EXCEPTION 'customer_identity_source_environment_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type = 'partner_customer' THEN
    IF NEW.owner_scope <> 'partner_unit' OR NEW.partner_unit_id IS DISTINCT FROM v_partner_unit THEN
      RAISE EXCEPTION 'customer_identity_partner_scope_mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.owner_scope <> 'matrix' OR NEW.partner_unit_id IS NOT NULL THEN
    RAISE EXCEPTION 'customer_identity_matrix_scope_required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.validate_customer_identity_reference()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_target_env env_t;
  v_link_env env_t;
BEGIN
  IF NEW.superseded_by IS NOT NULL THEN
    SELECT environment INTO v_target_env FROM commerce.customer_identities WHERE id = NEW.superseded_by;
    IF v_target_env IS NULL OR v_target_env <> NEW.environment THEN
      RAISE EXCEPTION 'customer_identity_superseded_environment_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.type_source_link_id IS NOT NULL THEN
    SELECT environment INTO v_link_env FROM commerce.customer_identity_links WHERE id = NEW.type_source_link_id AND identity_id = NEW.id;
    IF v_link_env IS NULL OR v_link_env <> NEW.environment THEN RAISE EXCEPTION 'customer_identity_type_source_mismatch' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.classification_source_link_id IS NOT NULL THEN
    SELECT environment INTO v_link_env FROM commerce.customer_identity_links WHERE id = NEW.classification_source_link_id AND identity_id = NEW.id;
    IF v_link_env IS NULL OR v_link_env <> NEW.environment THEN RAISE EXCEPTION 'customer_identity_classification_source_mismatch' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.vip_source_link_id IS NOT NULL THEN
    SELECT environment INTO v_link_env FROM commerce.customer_identity_links WHERE id = NEW.vip_source_link_id AND identity_id = NEW.id;
    IF v_link_env IS NULL OR v_link_env <> NEW.environment THEN RAISE EXCEPTION 'customer_identity_vip_source_mismatch' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.validate_customer_identity_candidate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_left_env env_t;
  v_right_env env_t;
  v_left_identity UUID;
  v_right_identity UUID;
BEGIN
  SELECT environment, identity_id INTO v_left_env, v_left_identity
    FROM commerce.customer_identity_links WHERE id = NEW.left_link_id AND ended_at IS NULL;
  SELECT environment, identity_id INTO v_right_env, v_right_identity
    FROM commerce.customer_identity_links WHERE id = NEW.right_link_id AND ended_at IS NULL;
  IF v_left_env IS NULL OR v_right_env IS NULL THEN
    RAISE EXCEPTION 'customer_identity_candidate_link_inactive' USING ERRCODE = '23514';
  END IF;
  IF v_left_env <> NEW.environment OR v_right_env <> NEW.environment THEN
    RAISE EXCEPTION 'customer_identity_candidate_environment_mismatch' USING ERRCODE = '23514';
  END IF;
  IF v_left_identity = v_right_identity THEN
    RAISE EXCEPTION 'customer_identity_candidate_same_identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ops.validate_privacy_request_environment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_env env_t;
BEGIN
  SELECT environment INTO v_env FROM commerce.customer_identities WHERE id = NEW.identity_id;
  IF v_env IS NULL OR v_env <> NEW.environment THEN
    RAISE EXCEPTION 'privacy_request_environment_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ops.validate_privacy_event_environment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_env env_t;
BEGIN
  SELECT environment INTO v_env FROM ops.privacy_requests WHERE id = NEW.privacy_request_id;
  IF v_env IS NULL OR v_env <> NEW.environment THEN
    RAISE EXCEPTION 'privacy_event_environment_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ops.guard_privacy_event_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy_request_events_append_only' USING ERRCODE = '23001';
END;
$$;

DROP TRIGGER IF EXISTS customer_identity_link_validate ON commerce.customer_identity_links;
CREATE TRIGGER customer_identity_link_validate
  BEFORE INSERT OR UPDATE OF environment, identity_id, source_type, source_id, owner_scope, partner_unit_id
  ON commerce.customer_identity_links FOR EACH ROW EXECUTE FUNCTION commerce.validate_customer_identity_link();

DROP TRIGGER IF EXISTS customer_identity_reference_validate ON commerce.customer_identities;
CREATE TRIGGER customer_identity_reference_validate
  BEFORE INSERT OR UPDATE OF environment, superseded_by, type_source_link_id, classification_source_link_id, vip_source_link_id
  ON commerce.customer_identities FOR EACH ROW EXECUTE FUNCTION commerce.validate_customer_identity_reference();

DROP TRIGGER IF EXISTS customer_identity_candidate_validate ON commerce.customer_identity_candidates;
CREATE TRIGGER customer_identity_candidate_validate
  BEFORE INSERT OR UPDATE OF environment, left_link_id, right_link_id
  ON commerce.customer_identity_candidates FOR EACH ROW EXECUTE FUNCTION commerce.validate_customer_identity_candidate();

DROP TRIGGER IF EXISTS privacy_request_validate ON ops.privacy_requests;
CREATE TRIGGER privacy_request_validate
  BEFORE INSERT OR UPDATE OF environment, identity_id
  ON ops.privacy_requests FOR EACH ROW EXECUTE FUNCTION ops.validate_privacy_request_environment();

DROP TRIGGER IF EXISTS privacy_event_validate ON ops.privacy_request_events;
CREATE TRIGGER privacy_event_validate
  BEFORE INSERT ON ops.privacy_request_events FOR EACH ROW EXECUTE FUNCTION ops.validate_privacy_event_environment();

DROP TRIGGER IF EXISTS privacy_event_immutable ON ops.privacy_request_events;
CREATE TRIGGER privacy_event_immutable
  BEFORE UPDATE OR DELETE ON ops.privacy_request_events FOR EACH ROW EXECUTE FUNCTION ops.guard_privacy_event_immutable();

DROP TRIGGER IF EXISTS env_immutable_customer_identities ON commerce.customer_identities;
CREATE TRIGGER env_immutable_customer_identities
  BEFORE UPDATE OF environment ON commerce.customer_identities FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
DROP TRIGGER IF EXISTS env_immutable_customer_identity_links ON commerce.customer_identity_links;
CREATE TRIGGER env_immutable_customer_identity_links
  BEFORE UPDATE OF environment ON commerce.customer_identity_links FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
DROP TRIGGER IF EXISTS env_immutable_customer_identity_candidates ON commerce.customer_identity_candidates;
CREATE TRIGGER env_immutable_customer_identity_candidates
  BEFORE UPDATE OF environment ON commerce.customer_identity_candidates FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
DROP TRIGGER IF EXISTS env_immutable_privacy_requests ON ops.privacy_requests;
CREATE TRIGGER env_immutable_privacy_requests
  BEFORE UPDATE OF environment ON ops.privacy_requests FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS customer_identities_set_updated_at ON commerce.customer_identities;
CREATE TRIGGER customer_identities_set_updated_at BEFORE UPDATE ON commerce.customer_identities
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();
DROP TRIGGER IF EXISTS customer_identity_candidates_set_updated_at ON commerce.customer_identity_candidates;
CREATE TRIGGER customer_identity_candidates_set_updated_at BEFORE UPDATE ON commerce.customer_identity_candidates
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();
DROP TRIGGER IF EXISTS privacy_requests_set_updated_at ON ops.privacy_requests;
CREATE TRIGGER privacy_requests_set_updated_at BEFORE UPDATE ON ops.privacy_requests
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

REVOKE ALL ON commerce.customer_identities, commerce.customer_identity_links,
  commerce.customer_identity_candidates, ops.privacy_requests, ops.privacy_request_events FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    REVOKE ALL ON commerce.customer_identities, commerce.customer_identity_links,
      commerce.customer_identity_candidates, ops.privacy_requests, ops.privacy_request_events
      FROM farejador_partner_app;
    IF has_table_privilege('farejador_partner_app', 'commerce.customer_identities', 'SELECT')
       OR has_table_privilege('farejador_partner_app', 'commerce.customer_identity_links', 'SELECT')
       OR has_table_privilege('farejador_partner_app', 'commerce.customer_identity_candidates', 'SELECT')
       OR has_table_privilege('farejador_partner_app', 'ops.privacy_requests', 'SELECT')
       OR has_table_privilege('farejador_partner_app', 'ops.privacy_request_events', 'SELECT') THEN
      RAISE EXCEPTION '0142 privilege smoke failed: partner role reached owner-only customer data';
    END IF;
  END IF;
END;
$$;

COMMENT ON TABLE commerce.customer_identities IS
  'Etapa 9: identidade canonica sem PII. Nome/telefone/email continuam apenas nas fontes competentes.';
COMMENT ON TABLE commerce.customer_identity_links IS
  'Etapa 9: vinculo reversivel entre identidade e fonte, sem copiar PII.';
COMMENT ON TABLE commerce.customer_identity_candidates IS
  'Etapa 9: sugestoes deterministicas para revisao owner; evidencia nao contem PII.';
COMMENT ON TABLE ops.privacy_requests IS
  'Etapa 9: fluxo owner-only de portabilidade/privacidade. Nao implica execucao destrutiva.';
COMMENT ON TABLE ops.privacy_request_events IS
  'Etapa 9: trilha append-only e sanitizada das transicoes de privacidade.';

COMMIT;
