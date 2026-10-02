-- Integrity fixes for Meta identity decisions, Google finance and delivery review.
BEGIN;

CREATE VIEW marketing.google_spend_expected AS
SELECT i.environment,i.id,i.account_id,i.campaign_id,i.metric_date,
  CASE WHEN c.owned AND a.finance_since IS NOT NULL AND i.metric_date>=a.finance_since
    THEN round(i.cost_micros::numeric/1000000,2) ELSE 0::numeric END expected_spend
FROM marketing.google_insights_daily i
JOIN marketing.google_campaigns c USING(environment,account_id,campaign_id)
JOIN marketing.google_accounts a USING(environment,account_id)
WHERE i.entity_level='campaign';

ALTER TABLE marketing.meta_ad_identities
  ADD COLUMN automatic_scope text CHECK(automatic_scope IN ('matrix','external','pending')),
  ADD COLUMN identity_fingerprint text;
UPDATE marketing.meta_ad_identities SET automatic_scope=scope;
ALTER TABLE marketing.meta_ad_identities ALTER COLUMN automatic_scope SET NOT NULL;
ALTER TABLE marketing.meta_ad_identities ALTER COLUMN automatic_scope SET DEFAULT 'pending';

CREATE TABLE marketing.meta_ad_identity_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  environment public.env_t NOT NULL,
  ad_account_id text NOT NULL,
  ad_id text NOT NULL,
  identity_fingerprint text NOT NULL,
  scope text NOT NULL CHECK(scope IN ('matrix','external','automatic')),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 1000),
  actor_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(environment,ad_account_id,ad_id)
    REFERENCES marketing.meta_ad_identities(environment,ad_account_id,ad_id)
);
CREATE INDEX meta_identity_decision_latest_idx ON marketing.meta_ad_identity_decisions
  (environment,ad_account_id,ad_id,decision_seq DESC);
CREATE FUNCTION marketing.reject_identity_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'meta_identity_decision_immutable';
END $$;
CREATE TRIGGER meta_identity_decision_immutable BEFORE UPDATE OR DELETE
  ON marketing.meta_ad_identity_decisions FOR EACH ROW
  EXECUTE FUNCTION marketing.reject_identity_decision_mutation();
ALTER TABLE marketing.meta_ad_identity_decisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE marketing.google_conversion_outbox DROP CONSTRAINT google_conversion_outbox_status_check;
ALTER TABLE marketing.google_conversion_outbox ADD CONSTRAINT google_conversion_outbox_status_check
  CHECK(status IN ('pending','processing','accepted','sent','failed','dead_letter','review','suppressed','closed'));

CREATE INDEX marketing_spend_ledger_source_idx ON finance.matriz_ledger_transactions
  (environment,source_type,(metadata->>'insight_id'))
  WHERE source_type IN ('marketing.google_spend.adjustment','marketing.meta_spend.adjustment');
CREATE INDEX google_click_destination_date_idx ON marketing.google_clicks(environment,destination,captured_at);
CREATE INDEX meta_identity_pending_idx ON marketing.meta_ad_identities(environment,ad_account_id,campaign_id)
  WHERE scope='pending';

-- This precise SQL failure happened before the external POST. Do not reopen
-- any ambiguous delivery, acknowledged event or unrelated terminal error.
UPDATE marketing.capi_outbox SET status='failed',attempts=0,not_before=now(),
  locked_at=NULL,locked_by=NULL,dead_lettered_at=NULL,updated_at=now()
WHERE status IN ('failed','dead_letter') AND sent_at IS NULL
  AND events_received IS NULL AND fbtrace_id IS NULL
  AND last_error_summary IN ('column "ad_account_id" does not exist',
    'column queue.ad_account_id does not exist');

REVOKE ALL ON marketing.google_spend_expected,marketing.meta_ad_identity_decisions FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','farejador_partner_app','partner_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON marketing.google_spend_expected,marketing.meta_ad_identity_decisions FROM %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
