-- Observações determinísticas dos contadores das redes; nenhum conteúdo pessoal é copiado.
BEGIN;
CREATE TABLE analytics.organic_metric_observations (
  environment env_t NOT NULL,
  platform text NOT NULL CHECK (platform IN ('instagram','facebook','tiktok','youtube')),
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 100),
  post_id text NOT NULL CHECK (length(post_id) BETWEEN 1 AND 100),
  observed_at timestamptz NOT NULL,
  metric text NOT NULL CHECK (metric IN ('views','post_media_view','view_count')),
  views bigint CHECK (views BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (environment,platform,account_id,post_id,observed_at)
);
CREATE INDEX organic_metric_history_recent ON analytics.organic_metric_observations(environment,observed_at);
ALTER TABLE analytics.organic_metric_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON analytics.organic_metric_observations FROM PUBLIC,farejador_partner_app;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON analytics.organic_metric_observations FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,DELETE ON analytics.organic_metric_observations TO service_role;
  END IF;
END $$;
CREATE FUNCTION analytics.guard_organic_metric_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'organic_metric_observation_immutable';
END $$;
CREATE TRIGGER organic_metric_observation_immutable BEFORE UPDATE ON analytics.organic_metric_observations
  FOR EACH ROW EXECUTE FUNCTION analytics.guard_organic_metric_observation();
COMMENT ON TABLE analytics.organic_metric_observations IS
  'Contadores observados, sem interpolação histórica; retenção operacional de 180 dias.';
COMMIT;
