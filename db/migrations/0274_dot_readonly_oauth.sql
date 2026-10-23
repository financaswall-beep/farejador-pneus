-- Private authorization for the owner's read-only Dot connector. No commercial writes.
BEGIN;
CREATE TABLE network.dot_oauth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_hash text NOT NULL UNIQUE CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  environment env_t NOT NULL,
  session_hash text NOT NULL,
  person_id uuid NOT NULL REFERENCES network.partner_people(id),
  collaborator_id uuid NOT NULL REFERENCES network.matriz_collaborators(id),
  request_params jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  consumed_at timestamptz
);
CREATE TABLE network.dot_oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  person_id uuid NOT NULL REFERENCES network.partner_people(id),
  collaborator_id uuid NOT NULL REFERENCES network.matriz_collaborators(id),
  client_id text NOT NULL,
  resource text NOT NULL,
  scope text NOT NULL CHECK(scope='farejador.read'),
  code_hash text NOT NULL UNIQUE CHECK(code_hash ~ '^[a-f0-9]{64}$'),
  code_challenge text NOT NULL CHECK(code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  redirect_uri text NOT NULL,
  code_expires_at timestamptz NOT NULL DEFAULT now()+interval '2 minutes',
  code_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  revoked_at timestamptz
);
CREATE INDEX dot_grants_owner ON network.dot_oauth_grants(environment,person_id) WHERE revoked_at IS NULL;
CREATE TABLE network.dot_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  grant_id uuid NOT NULL REFERENCES network.dot_oauth_grants(id),
  access_hash text NOT NULL UNIQUE CHECK(access_hash ~ '^[a-f0-9]{64}$'),
  refresh_hash text NOT NULL UNIQUE CHECK(refresh_hash ~ '^[a-f0-9]{64}$'),
  access_expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);
CREATE INDEX dot_tokens_grant ON network.dot_oauth_tokens(environment,grant_id);

-- Revocation is permanent even if a user is later reactivated/promoted again.
CREATE FUNCTION network.revoke_dot_authorizations() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,network AS $$
BEGIN
  IF TG_TABLE_NAME='partner_people' THEN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
      OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.username IS DISTINCT FROM OLD.username THEN
      UPDATE network.dot_oauth_grants SET revoked_at=COALESCE(revoked_at,now())
        WHERE environment=OLD.environment AND person_id=OLD.id AND revoked_at IS NULL;
      DELETE FROM network.dot_oauth_requests WHERE environment=OLD.environment AND person_id=OLD.id;
    END IF;
  ELSE
    IF NEW.panel_role IS DISTINCT FROM OLD.panel_role OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR NEW.person_id IS DISTINCT FROM OLD.person_id THEN
      UPDATE network.dot_oauth_grants SET revoked_at=COALESCE(revoked_at,now())
        WHERE environment=OLD.environment AND collaborator_id=OLD.id AND revoked_at IS NULL;
      DELETE FROM network.dot_oauth_requests WHERE environment=OLD.environment AND collaborator_id=OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION network.revoke_dot_authorizations() FROM PUBLIC;
CREATE TRIGGER dot_people_revocation AFTER UPDATE ON network.partner_people
  FOR EACH ROW EXECUTE FUNCTION network.revoke_dot_authorizations();
CREATE TRIGGER dot_collaborator_revocation AFTER UPDATE ON network.matriz_collaborators
  FOR EACH ROW EXECUTE FUNCTION network.revoke_dot_authorizations();

CREATE TRIGGER dot_request_environment BEFORE INSERT OR UPDATE ON network.dot_oauth_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','partner_people','person_id');
CREATE TRIGGER dot_grant_environment BEFORE INSERT OR UPDATE ON network.dot_oauth_grants
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','partner_people','person_id');
CREATE TRIGGER dot_token_environment BEFORE INSERT OR UPDATE ON network.dot_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','dot_oauth_grants','grant_id');
CREATE TRIGGER dot_request_collaborator_environment BEFORE INSERT OR UPDATE ON network.dot_oauth_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','matriz_collaborators','collaborator_id');
CREATE TRIGGER dot_grant_collaborator_environment BEFORE INSERT OR UPDATE ON network.dot_oauth_grants
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','matriz_collaborators','collaborator_id');
CREATE TRIGGER dot_request_environment_immutable BEFORE UPDATE OF environment ON network.dot_oauth_requests
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
CREATE TRIGGER dot_grant_environment_immutable BEFORE UPDATE OF environment ON network.dot_oauth_grants
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
CREATE TRIGGER dot_token_environment_immutable BEFORE UPDATE OF environment ON network.dot_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
ALTER TABLE network.dot_oauth_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.dot_oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.dot_oauth_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON network.dot_oauth_requests,network.dot_oauth_grants,network.dot_oauth_tokens FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','farejador_partner_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON network.dot_oauth_requests,network.dot_oauth_grants,network.dot_oauth_tokens FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
