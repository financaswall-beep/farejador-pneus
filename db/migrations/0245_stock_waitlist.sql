-- Lista de espera reutiliza os interesses consentidos. Não movimenta estoque.
BEGIN;
ALTER TABLE ops.stock_interests
  ADD COLUMN quantity integer CHECK (quantity BETWEEN 1 AND 999),
  ADD COLUMN vehicle_type text CHECK (vehicle_type IN ('car','motorcycle')),
  ADD COLUMN offer_text text,
  ADD COLUMN contacted_at timestamptz,
  ADD COLUMN version integer NOT NULL DEFAULT 0;
UPDATE ops.stock_interests SET contacted_at=updated_at WHERE status='contacted';
CREATE INDEX stock_interests_queue ON ops.stock_interests(environment,status,consent_at);

CREATE TABLE ops.stock_interest_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  interest_id uuid NOT NULL REFERENCES ops.stock_interests(id),
  from_status text,
  to_status text NOT NULL,
  actor text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ops.stock_interest_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.stock_interest_events FROM PUBLIC, farejador_partner_app;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON ops.stock_interest_events FROM anon; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON ops.stock_interest_events FROM authenticated; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT SELECT,INSERT ON ops.stock_interest_events TO service_role; END IF;
END $$;
CREATE FUNCTION ops.track_stock_interest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    NEW.version := OLD.version+1;
    NEW.updated_at := now();
    IF NEW.status='contacted' AND OLD.status<>'contacted' THEN NEW.contacted_at:=now(); END IF;
  END IF;
  INSERT INTO ops.stock_interest_events(environment,interest_id,from_status,to_status,actor)
    VALUES(NEW.environment,NEW.id,CASE WHEN TG_OP='UPDATE' THEN OLD.status END,NEW.status,NEW.updated_by);
  RETURN NEW;
END $$;
-- AFTER INSERT para a FK e BEFORE UPDATE para versionamento otimista.
CREATE TRIGGER stock_interest_created AFTER INSERT ON ops.stock_interests
  FOR EACH ROW EXECUTE FUNCTION ops.track_stock_interest();
CREATE TRIGGER stock_interest_changed BEFORE UPDATE ON ops.stock_interests
  FOR EACH ROW EXECUTE FUNCTION ops.track_stock_interest();
CREATE FUNCTION ops.protect_stock_interest_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'stock_interest_event_immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ops.stock_interests s WHERE s.id=NEW.interest_id AND s.environment=NEW.environment) THEN
    RAISE EXCEPTION 'stock_interest_event_scope_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_interest_event_guard BEFORE INSERT OR UPDATE OR DELETE ON ops.stock_interest_events
  FOR EACH ROW EXECUTE FUNCTION ops.protect_stock_interest_event();
COMMIT;
