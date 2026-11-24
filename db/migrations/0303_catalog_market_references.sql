BEGIN;

CREATE TABLE commerce.catalog_market_references (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  environment env_t NOT NULL,
  product_id uuid NOT NULL REFERENCES commerce.products(id),
  model text NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 120),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  sources text[] NOT NULL CHECK (cardinality(sources) BETWEEN 1 AND 12),
  observed_on date NOT NULL,
  valid_until date CHECK (valid_until >= observed_on),
  bot_enabled boolean NOT NULL CHECK (NOT bot_enabled OR valid_until IS NOT NULL),
  product_spec jsonb NOT NULL,
  actor_label text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX catalog_market_reference_latest ON commerce.catalog_market_references
  (environment, product_id, id DESC);
CREATE TRIGGER catalog_market_reference_product_env BEFORE INSERT OR UPDATE ON commerce.catalog_market_references
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','products','product_id');
ALTER TABLE commerce.catalog_market_references ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.catalog_market_references FROM PUBLIC, farejador_partner_app;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON commerce.catalog_market_references FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
