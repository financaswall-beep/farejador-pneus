-- ============================================================
-- 0203 - Canario do painel moderno por unidade + telemetria minima
--
-- Aditiva e desligada por padrao. O painel legado continua sendo o
-- rollback: basta a Matriz desligar a chave da unidade.
-- ============================================================

ALTER TABLE network.partner_units
  ADD COLUMN IF NOT EXISTS modern_panel_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN network.partner_units.modern_panel_enabled IS
  'Libera o casco moderno somente para esta unidade. False preserva o painel legado.';

CREATE TABLE IF NOT EXISTS ops.partner_panel_canary_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment      env_t NOT NULL,
  partner_unit_id  UUID NOT NULL REFERENCES network.partner_units(id),
  panel_version    TEXT NOT NULL DEFAULT 'modern'
                   CHECK (panel_version IN ('legacy','modern')),
  page             TEXT NOT NULL CHECK (page IN ('resumo','retiradas')),
  event_type       TEXT NOT NULL CHECK (event_type IN ('page_open','read','write')),
  operation        TEXT CHECK (operation IS NULL OR operation IN (
                     'load_summary','load_pickups','confirm_pickup','cancel_pickup'
                   )),
  outcome          TEXT NOT NULL CHECK (outcome IN ('success','error')),
  status_code      INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  duration_ms      INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 600000),
  error_code       TEXT CHECK (error_code IS NULL OR (
                     char_length(error_code) BETWEEN 1 AND 80
                     AND error_code ~ '^[a-zA-Z0-9_.:-]+$'
                   )),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.partner_panel_canary_events IS
  'Saude tecnica do canario sem cliente, pedido, telefone, valores ou payload livre.';

CREATE INDEX IF NOT EXISTS partner_panel_canary_unit_time_idx
  ON ops.partner_panel_canary_events(environment,partner_unit_id,created_at DESC);

CREATE INDEX IF NOT EXISTS partner_panel_canary_errors_idx
  ON ops.partner_panel_canary_events(environment,partner_unit_id,created_at DESC)
  WHERE outcome='error';

DROP TRIGGER IF EXISTS env_match_partner_panel_canary_unit
  ON ops.partner_panel_canary_events;
CREATE TRIGGER env_match_partner_panel_canary_unit
  BEFORE INSERT OR UPDATE OF partner_unit_id ON ops.partner_panel_canary_events
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','partner_units','partner_unit_id'
  );

DROP TRIGGER IF EXISTS env_immutable_partner_panel_canary_events
  ON ops.partner_panel_canary_events;
CREATE TRIGGER env_immutable_partner_panel_canary_events
  BEFORE UPDATE OF environment ON ops.partner_panel_canary_events
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

ALTER TABLE ops.partner_panel_canary_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_panel_canary_insert_isolation
  ON ops.partner_panel_canary_events;
CREATE POLICY partner_panel_canary_insert_isolation
  ON ops.partner_panel_canary_events
  FOR INSERT
  WITH CHECK (
    network.current_partner_unit() IS NOT NULL
    AND partner_unit_id=network.current_partner_unit()
  );

REVOKE ALL ON ops.partner_panel_canary_events FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO farejador_partner_app;
GRANT INSERT ON ops.partner_panel_canary_events TO farejador_partner_app;

DO $smoke$
DECLARE
  v_default TEXT;
BEGIN
  SELECT column_default
    INTO v_default
    FROM information_schema.columns
   WHERE table_schema='network' AND table_name='partner_units'
     AND column_name='modern_panel_enabled';
  IF v_default IS NULL OR v_default NOT ILIKE '%false%' THEN
    RAISE EXCEPTION 'smoke 0203: flag do painel nao nasceu desligada';
  END IF;
  IF to_regclass('ops.partner_panel_canary_events') IS NULL THEN
    RAISE EXCEPTION 'smoke 0203: tabela de telemetria ausente';
  END IF;
END
$smoke$;
