BEGIN;
ALTER TABLE network.dot_oauth_grants
  ADD COLUMN installment_reviews_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE network.dot_installment_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  grant_id uuid NOT NULL REFERENCES network.dot_oauth_grants(id),
  order_id uuid NOT NULL REFERENCES commerce.wholesale_orders(id),
  installment_number integer NOT NULL CHECK (installment_number BETWEEN 1 AND 120),
  old_due date NOT NULL, new_due date NOT NULL CHECK (new_due <> old_due),
  balance numeric(14,2) NOT NULL CHECK (balance > 0),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  confirmed_at timestamptz,
  restored_at timestamptz CHECK (restored_at IS NULL OR confirmed_at IS NOT NULL)
);
CREATE INDEX dot_installment_reviews_grant ON network.dot_installment_reviews(environment,grant_id);
CREATE TRIGGER dot_review_grant_environment BEFORE INSERT OR UPDATE ON network.dot_installment_reviews
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','dot_oauth_grants','grant_id');
CREATE TRIGGER dot_review_order_environment BEFORE INSERT OR UPDATE ON network.dot_installment_reviews
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','wholesale_orders','order_id');
ALTER TABLE network.dot_installment_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON network.dot_installment_reviews FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','farejador_partner_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON network.dot_installment_reviews FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
