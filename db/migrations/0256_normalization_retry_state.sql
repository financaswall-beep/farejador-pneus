BEGIN;
-- Apenas estado operacional: o payload e os identificadores brutos não mudam.
CREATE TABLE ops.normalization_retries (
  environment env_t NOT NULL,
  raw_event_id BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at TIMESTAMPTZ,
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,raw_event_id,received_at),
  FOREIGN KEY(raw_event_id,received_at) REFERENCES raw.raw_events(id,received_at)
);
CREATE FUNCTION ops.guard_normalization_retry_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM raw.raw_events r WHERE r.id=NEW.raw_event_id
      AND r.received_at=NEW.received_at AND r.environment=NEW.environment) THEN
    RAISE EXCEPTION 'normalization_retry_environment_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_normalization_retry_environment BEFORE INSERT OR UPDATE OF environment,raw_event_id,received_at
  ON ops.normalization_retries FOR EACH ROW EXECUTE FUNCTION ops.guard_normalization_retry_environment();
REVOKE ALL ON FUNCTION ops.guard_normalization_retry_environment() FROM PUBLIC;
ALTER TABLE ops.normalization_retries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.normalization_retries FROM PUBLIC;
CREATE INDEX normalization_retries_due_idx ON ops.normalization_retries(environment,next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;
DO $smoke$ BEGIN
  IF to_regclass('ops.normalization_retries') IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='ops.normalization_retries'::regclass
      AND tgname='guard_normalization_retry_environment') THEN
    RAISE EXCEPTION '0256: estado de retomada incompleto';
  END IF;
END $smoke$;
COMMIT;
