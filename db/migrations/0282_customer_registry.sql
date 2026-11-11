-- Cadastro comercial sobreposto: não altera raw.*, core.* ou históricos de venda.
BEGIN;
CREATE TABLE commerce.customer_registry (
  environment env_t NOT NULL,
  source text NOT NULL CHECK (source IN ('chatwoot','balcao','parceiro','atacado')),
  source_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160),
  commercial_profile text NOT NULL CHECK (commercial_profile IN ('varejo','atacado','nao_classificado')),
  phone text,
  email text NOT NULL DEFAULT '',
  document_number text NOT NULL DEFAULT '',
  postal_code text NOT NULL DEFAULT '',
  street text NOT NULL DEFAULT '', number text NOT NULL DEFAULT '',
  complement text NOT NULL DEFAULT '', neighborhood text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '', state text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment,source,source_id)
);
CREATE TABLE commerce.customer_registry_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  source text NOT NULL, source_id uuid NOT NULL,
  version integer NOT NULL,
  actor text NOT NULL,
  changed_fields text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment,source,source_id,version)
);
CREATE TABLE commerce.customer_registry_requests (
  environment env_t NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  source text NOT NULL CHECK (source IN ('balcao','atacado')),
  source_id uuid NOT NULL,
  PRIMARY KEY(environment,idempotency_key)
);
ALTER TABLE commerce.customer_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.customer_registry_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.customer_registry_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.customer_registry,commerce.customer_registry_audit,commerce.customer_registry_requests FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','partner_app','farejador_partner_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON commerce.customer_registry,commerce.customer_registry_audit,commerce.customer_registry_requests FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMENT ON TABLE commerce.customer_registry IS 'Revisão humana de cadastro por fonte. Não modifica contato normalizado nem define canal/preço de venda.';
COMMIT;
