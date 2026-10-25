-- Owner controls and technical probe state. No commercial or conversation writes.
BEGIN;
ALTER TABLE network.dot_event_subscriptions DROP CONSTRAINT dot_event_subscriptions_event_name_check;
ALTER TABLE network.dot_event_subscriptions ADD CONSTRAINT dot_event_subscriptions_event_name_check CHECK(event_name IN (
 'farejador.conversa.atualizada','farejador.entrega.atencao','farejador.estoque.procura',
 'farejador.estoque.disponivel','farejador.atendimento.inconsistencia','farejador.financeiro.atencao',
 'farejador.marketing.atencao','farejador.sistema.atencao'));
ALTER TABLE ops.dot_event_deliveries DROP CONSTRAINT dot_event_deliveries_kind_check;
ALTER TABLE ops.dot_event_deliveries ADD CONSTRAINT dot_event_deliveries_kind_check CHECK(kind IN ('conversation','order','signal'));

CREATE TABLE network.dot_event_settings (
 environment env_t PRIMARY KEY,
 settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid NOT NULL REFERENCES network.partner_people(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE network.dot_event_settings_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment env_t NOT NULL,
 version integer NOT NULL,settings jsonb NOT NULL,updated_by uuid NOT NULL REFERENCES network.partner_people(id),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(environment,version)
);
CREATE TABLE ops.dot_external_health (
 environment env_t PRIMARY KEY,status text NOT NULL CHECK(status IN ('healthy','unhealthy')),
 consecutive_failures integer NOT NULL CHECK(consecutive_failures>=0),
 failing_since timestamptz,last_checked_at timestamptz NOT NULL,
 http_status integer CHECK(http_status BETWEEN 100 AND 599)
);
CREATE TRIGGER dot_settings_environment BEFORE INSERT OR UPDATE ON network.dot_event_settings
 FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','partner_people','updated_by');
CREATE TRIGGER dot_settings_history_environment BEFORE INSERT OR UPDATE ON network.dot_event_settings_history
 FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','partner_people','updated_by');
CREATE TRIGGER dot_settings_environment_immutable BEFORE UPDATE OF environment ON network.dot_event_settings
 FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
CREATE TRIGGER dot_settings_history_immutable BEFORE UPDATE OR DELETE ON network.dot_event_settings_history
 FOR EACH ROW EXECUTE FUNCTION ops.guard_atendente_job_event_immutable();
DO $$ DECLARE item text; role_name text; BEGIN
 FOREACH item IN ARRAY ARRAY['network.dot_event_settings','network.dot_event_settings_history','ops.dot_external_health'] LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC',item);
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','farejador_partner_app'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('REVOKE ALL ON %s FROM %I',item,role_name);
   END IF;
  END LOOP;
 END LOOP;
END $$;
COMMIT;
