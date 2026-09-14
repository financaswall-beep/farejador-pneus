BEGIN;

-- Configuração humana, versionada, da finalidade geográfica e das ofertas.
-- Nenhuma campanha nasce com município, produto ou cobertura presumidos.
CREATE TABLE marketing.geography_bindings (
  id BIGSERIAL PRIMARY KEY,
  environment env_t NOT NULL,
  ad_account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  allocation TEXT NOT NULL CHECK (allocation IN ('dedicated','shared')),
  municipality TEXT,
  valid_from DATE NOT NULL,
  valid_until DATE NOT NULL,
  coverage TEXT NOT NULL CHECK (coverage IN ('unknown','pickup','confirmed')),
  offers JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(offers)='array'),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until>=valid_from),
  CHECK (allocation<>'dedicated' OR (municipality IS NOT NULL AND length(btrim(municipality))>0))
);
CREATE INDEX geography_bindings_campaign_idx ON marketing.geography_bindings
  (environment,ad_account_id,campaign_id,id DESC);

-- Observações da configuração Meta; não são a data exata de uma alteração.
CREATE TABLE marketing.geography_meta_snapshots (
  id BIGSERIAL PRIMARY KEY,
  environment env_t NOT NULL,
  ad_account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object')
);
CREATE INDEX geography_meta_snapshots_campaign_idx ON marketing.geography_meta_snapshots
  (environment,ad_account_id,campaign_id,observed_at DESC);

CREATE TABLE marketing.geography_test_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  ad_account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  request_key UUID NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(environment,request_key)
);

CREATE FUNCTION marketing.geography_preserve_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Geography history is append-only; insert a new version';
END $$;
CREATE TRIGGER geography_bindings_preserve_version BEFORE UPDATE ON marketing.geography_bindings
  FOR EACH ROW EXECUTE FUNCTION marketing.geography_preserve_version();
CREATE TRIGGER geography_snapshots_preserve_version BEFORE UPDATE ON marketing.geography_meta_snapshots
  FOR EACH ROW EXECUTE FUNCTION marketing.geography_preserve_version();
CREATE TRIGGER geography_plans_preserve_version BEFORE UPDATE ON marketing.geography_test_plans
  FOR EACH ROW EXECUTE FUNCTION marketing.geography_preserve_version();

ALTER TABLE marketing.geography_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.geography_meta_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.geography_test_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON marketing.geography_bindings,marketing.geography_meta_snapshots,marketing.geography_test_plans FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','partner_app','farejador_partner_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON marketing.geography_bindings,marketing.geography_meta_snapshots,marketing.geography_test_plans FROM %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
