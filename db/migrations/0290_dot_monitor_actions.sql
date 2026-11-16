BEGIN;

ALTER TABLE network.dot_event_subscriptions DROP CONSTRAINT dot_event_subscriptions_event_name_check;
ALTER TABLE network.dot_event_subscriptions ADD CONSTRAINT dot_event_subscriptions_event_name_check CHECK(event_name IN (
 'farejador.conversa.atualizada','farejador.entrega.atencao','farejador.estoque.procura',
 'farejador.estoque.disponivel','farejador.atendimento.inconsistencia','farejador.financeiro.atencao',
 'farejador.marketing.atencao','farejador.sistema.atencao','farejador.marketing.rascunho','farejador.estoque.lote'));

-- Uma renovação ou outra conexão da mesma Milly nunca dispensa a decisão do dono.
CREATE TABLE network.dot_monitor_owners (
  environment env_t NOT NULL, person_id uuid NOT NULL REFERENCES network.partner_people(id),
  client_id text NOT NULL, resource text NOT NULL,
  PRIMARY KEY(environment,person_id,client_id,resource)
);
CREATE TRIGGER dot_monitor_owner_person_env BEFORE INSERT OR UPDATE ON network.dot_monitor_owners
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','partner_people','person_id');
INSERT INTO network.dot_monitor_owners
SELECT DISTINCT g.environment,g.person_id,g.client_id,g.resource FROM network.dot_oauth_grants g
JOIN network.dot_event_subscriptions s ON s.environment=g.environment AND s.grant_id=g.id AND s.person_id=g.person_id
WHERE s.expires_at>s.created_at;

CREATE TABLE ops.dot_internal_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  person_id uuid NOT NULL REFERENCES network.partner_people(id),
  entity_id uuid NOT NULL,
  event_name text NOT NULL,
  category text NOT NULL,
  event_id text NOT NULL,
  event_created_at timestamptz NOT NULL,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  priority text NOT NULL CHECK (priority IN ('normal','alta')),
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment,person_id,entity_id,category)
);
CREATE INDEX dot_cases_open ON ops.dot_internal_cases(environment,person_id,updated_at DESC) WHERE closed_at IS NULL;
CREATE INDEX tire_lot_movement_recorded ON commerce.tire_lot_movements(environment,created_at DESC);
CREATE TRIGGER dot_internal_case_person_env BEFORE INSERT OR UPDATE ON ops.dot_internal_cases
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','partner_people','person_id');

CREATE TABLE network.dot_operation_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  grant_id uuid NOT NULL REFERENCES network.dot_oauth_grants(id),
  tool_name text NOT NULL, operation_key uuid NOT NULL, fingerprint text NOT NULL,
  details jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '15 minutes'),
  decision text CHECK (decision IN ('autorizada','recusada')),
  executed_at timestamptz,
  UNIQUE(environment,grant_id,tool_name,operation_key)
);
CREATE INDEX dot_operation_review_expiry ON network.dot_operation_reviews(expires_at);
CREATE TRIGGER dot_operation_review_grant_env BEFORE INSERT OR UPDATE ON network.dot_operation_reviews
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','dot_oauth_grants','grant_id');
ALTER TABLE ops.dot_internal_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.dot_operation_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.dot_monitor_owners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.dot_internal_cases,network.dot_operation_reviews,network.dot_monitor_owners FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','farejador_partner_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ops.dot_internal_cases,network.dot_operation_reviews,network.dot_monitor_owners FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
