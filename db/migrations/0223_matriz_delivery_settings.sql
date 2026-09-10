-- Cadastro opt-in: nenhuma linha inicial, nenhum raio/horário inventado no deploy.
CREATE TABLE IF NOT EXISTS commerce.matriz_delivery_settings (
  environment env_t PRIMARY KEY,
  settings JSONB NOT NULL CHECK (jsonb_typeof(settings)='object'),
  version INTEGER NOT NULL CHECK (version>0),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commerce.matriz_delivery_settings_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  version INTEGER NOT NULL,
  settings JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment,version)
);
CREATE TRIGGER matriz_delivery_environment_immutable BEFORE UPDATE OF environment
ON commerce.matriz_delivery_settings FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
CREATE TRIGGER matriz_delivery_events_immutable BEFORE UPDATE OR DELETE
ON commerce.matriz_delivery_settings_events FOR EACH ROW EXECUTE FUNCTION ops.guard_atendente_job_event_immutable();
REVOKE ALL ON commerce.matriz_delivery_settings,commerce.matriz_delivery_settings_events FROM PUBLIC;
ALTER TABLE commerce.matriz_delivery_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.matriz_delivery_settings_events ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','farejador_partner_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON commerce.matriz_delivery_settings,commerce.matriz_delivery_settings_events FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMENT ON TABLE commerce.matriz_delivery_settings IS
'Operação da Matriz no bot, salva pelo dono. Ausência de linha preserva comportamento legado.';
