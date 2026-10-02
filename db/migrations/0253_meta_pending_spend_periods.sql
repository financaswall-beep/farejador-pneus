-- Period-based verification of unresolved Meta spend. No approval or reset.
BEGIN;

ALTER TABLE marketing.meta_identity_accounts ADD COLUMN finance_since date;
-- Preserve all existing financial history; never choose today for an old account.
UPDATE marketing.meta_identity_accounts a SET finance_since=LEAST(
  (SELECT min(t.competence_on) FROM finance.matriz_ledger_transactions t WHERE t.environment=a.environment),
  (SELECT min(i.metric_date) FROM marketing.meta_insights_daily i
    WHERE i.environment=a.environment AND i.ad_account_id=a.ad_account_id),
  (a.verified_at AT TIME ZONE 'America/Sao_Paulo')::date);
ALTER TABLE marketing.meta_identity_accounts ALTER COLUMN finance_since SET NOT NULL;
ALTER TABLE marketing.meta_identity_accounts ALTER COLUMN finance_since
  SET DEFAULT '-infinity'::date;
-- The old server omits this field. Until the new server initializes it, retain
-- its existing accounting behavior during migration-before-deploy.
ALTER TABLE marketing.meta_ad_identities ADD COLUMN effective_status text;
ALTER TABLE marketing.meta_ad_identities ADD COLUMN has_matrix_identity boolean NOT NULL DEFAULT false;
ALTER TABLE marketing.meta_ad_identities ADD COLUMN metrics_backfill_pending boolean NOT NULL DEFAULT false;
UPDATE marketing.meta_ad_identities d SET metrics_backfill_pending=true WHERE d.scope='matrix'
  AND EXISTS(SELECT 1 FROM marketing.meta_ad_identity_decisions o WHERE o.environment=d.environment
    AND o.ad_account_id=d.ad_account_id AND o.ad_id=d.ad_id
    AND o.identity_fingerprint=d.identity_fingerprint AND o.scope='matrix' AND o.created_at>d.verified_at);
UPDATE marketing.meta_ad_identities SET has_matrix_identity=
  facebook_page_id='1434857906367394' OR instagram_user_id='17841465774227389'
WHERE facebook_page_id='1434857906367394' OR instagram_user_id='17841465774227389';
ALTER TABLE marketing.meta_sync_runs ADD COLUMN ad_account_id text;
CREATE INDEX meta_sync_account_recent_idx ON marketing.meta_sync_runs
  (environment,ad_account_id,started_at DESC);

CREATE TABLE marketing.meta_pending_spend_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment public.env_t NOT NULL,
  ad_account_id text NOT NULL,
  ad_id text NOT NULL,
  identity_fingerprint text NOT NULL,
  sync_run_id uuid NOT NULL,
  window_since date NOT NULL,
  window_until date NOT NULL,
  status text NOT NULL CHECK(status IN ('succeeded','failed')),
  error_code text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  CHECK(window_since<=window_until),
  UNIQUE(environment,ad_account_id,ad_id,identity_fingerprint,sync_run_id,window_since,window_until),
  FOREIGN KEY(environment,ad_account_id,ad_id)
    REFERENCES marketing.meta_ad_identities(environment,ad_account_id,ad_id),
  FOREIGN KEY(environment,sync_run_id) REFERENCES marketing.meta_sync_runs(environment,id)
);
CREATE INDEX meta_pending_checks_identity_idx ON marketing.meta_pending_spend_checks
  (environment,ad_account_id,ad_id,identity_fingerprint,checked_at DESC);
CREATE TRIGGER meta_pending_checks_immutable BEFORE UPDATE OR DELETE
  ON marketing.meta_pending_spend_checks FOR EACH ROW
  EXECUTE FUNCTION marketing.reject_identity_decision_mutation();

-- Quarantine: this table is never a financial posting source or campaign metric.
CREATE TABLE marketing.meta_pending_spend_daily (
  environment public.env_t NOT NULL,
  ad_account_id text NOT NULL,
  ad_id text NOT NULL,
  campaign_id text NOT NULL,
  identity_fingerprint text NOT NULL,
  metric_date date NOT NULL,
  spend numeric(14,2) NOT NULL CHECK(spend>=0),
  sync_run_id uuid NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,ad_account_id,ad_id,identity_fingerprint,metric_date),
  FOREIGN KEY(environment,ad_account_id,ad_id)
    REFERENCES marketing.meta_ad_identities(environment,ad_account_id,ad_id),
  FOREIGN KEY(environment,sync_run_id) REFERENCES marketing.meta_sync_runs(environment,id)
);
CREATE INDEX meta_pending_spend_period_idx ON marketing.meta_pending_spend_daily
  (environment,metric_date) WHERE spend>0;

CREATE FUNCTION marketing.meta_pending_spend_coverage(p_environment public.env_t,
  p_account text,p_ad text,p_fingerprint text)
RETURNS datemultirange LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT range_agg(daterange(c.window_since,c.window_until,'[]'))
    FROM marketing.meta_pending_spend_checks c WHERE c.environment=p_environment
      AND c.ad_account_id=p_account AND c.ad_id=p_ad AND c.identity_fingerprint=p_fingerprint
      AND c.status='succeeded'),'{}'::datemultirange)
    - COALESCE((SELECT range_agg(datemultirange(daterange(f.window_since,f.window_until,'[]'))
        - COALESCE((SELECT range_agg(daterange(s.window_since,s.window_until,'[]'))
          FROM marketing.meta_pending_spend_checks s WHERE s.environment=f.environment
            AND s.ad_account_id=f.ad_account_id AND s.ad_id=f.ad_id
            AND s.identity_fingerprint=f.identity_fingerprint AND s.status='succeeded'
            AND s.checked_at>f.checked_at),'{}'::datemultirange))
      FROM marketing.meta_pending_spend_checks f WHERE f.environment=p_environment
        AND f.ad_account_id=p_account AND f.ad_id=p_ad AND f.identity_fingerprint=p_fingerprint
        AND f.status='failed'),'{}'::datemultirange)
$$;

CREATE FUNCTION marketing.meta_pending_campaigns(p_environment public.env_t,
  p_since date,p_until date,p_enforce boolean DEFAULT true)
RETURNS TABLE(ad_account_id text,campaign_id text,ad_id text,reason text)
LANGUAGE sql STABLE AS $$
  WITH bounds AS (
    SELECT COALESCE(p_since,date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date) since,
      LEAST(COALESCE(p_until,(now() AT TIME ZONE 'America/Sao_Paulo')::date),
        (now() AT TIME ZONE 'America/Sao_Paulo')::date) until
  ), candidates AS (
    SELECT d.*,a.verified_at account_verified_at,
      GREATEST(b.since,a.finance_since) since,b.until
    FROM marketing.meta_ad_identities d
    JOIN marketing.meta_identity_accounts a USING(environment,ad_account_id)
    CROSS JOIN bounds b
    WHERE d.environment=p_environment AND d.scope='pending'
      AND GREATEST(b.since,a.finance_since)<=b.until
      AND (d.has_matrix_identity
        OR (d.facebook_page_id IS NULL AND d.instagram_user_id IS NULL))
  ), verification AS (
    SELECT d.*,
      marketing.meta_pending_spend_coverage(d.environment,d.ad_account_id,d.ad_id,d.identity_fingerprint) coverage,
      (SELECT max(c.checked_at) FROM marketing.meta_pending_spend_checks c
        WHERE c.environment=d.environment AND c.ad_account_id=d.ad_account_id
          AND c.ad_id=d.ad_id AND c.identity_fingerprint=d.identity_fingerprint
          AND c.status='succeeded' AND c.window_since<=d.until AND c.window_until>=d.since) verified_spend_at
    FROM candidates d
  )
  SELECT d.ad_account_id,d.campaign_id,d.ad_id,
    CASE WHEN EXISTS(SELECT 1 FROM marketing.meta_pending_spend_daily i
      WHERE i.environment=d.environment AND i.ad_account_id=d.ad_account_id AND i.ad_id=d.ad_id
        AND i.identity_fingerprint=d.identity_fingerprint AND i.spend>0
        AND i.metric_date BETWEEN d.since AND d.until) THEN 'unclassified_spend'
    ELSE 'verification_missing' END reason
  FROM verification d
  WHERE d.identity_fingerprint IS NULL OR d.verified_at<d.account_verified_at
    OR NOT (d.coverage @> daterange(d.since,d.until,'[]'))
    OR EXISTS(SELECT 1 FROM marketing.meta_pending_spend_daily i
      WHERE i.environment=d.environment AND i.ad_account_id=d.ad_account_id AND i.ad_id=d.ad_id
        AND i.identity_fingerprint=d.identity_fingerprint AND i.spend>0
        AND i.metric_date BETWEEN d.since AND d.until)
    OR EXISTS(SELECT 1 FROM marketing.meta_pending_spend_checks c
      WHERE c.environment=d.environment AND c.ad_account_id=d.ad_account_id AND c.ad_id=d.ad_id
        AND c.identity_fingerprint=d.identity_fingerprint AND c.status='failed'
        AND c.window_since<=d.until AND c.window_until>=d.since
        AND c.checked_at>COALESCE(d.verified_spend_at,'-infinity'::timestamptz))
    OR EXISTS(SELECT 1 FROM marketing.meta_sync_runs r
      WHERE r.environment=d.environment AND r.ad_account_id=d.ad_account_id AND r.status='failed'
        AND r.window_since<=d.until AND r.window_until>=d.since
        AND r.started_at>COALESCE(d.verified_spend_at,'-infinity'::timestamptz))
  UNION
  SELECT d.ad_account_id,d.campaign_id,d.ad_id,'verification_missing'
  FROM marketing.meta_ad_identities d JOIN marketing.meta_identity_accounts a USING(environment,ad_account_id)
  CROSS JOIN bounds b WHERE d.environment=p_environment AND d.scope='matrix' AND d.metrics_backfill_pending
    AND GREATEST(b.since,a.finance_since)<=b.until
  UNION
  -- Preserve evidence already collected under the old campaign-scoping model.
  SELECT i.ad_account_id,i.campaign_id,
    CASE WHEN i.entity_level='ad' THEN i.entity_id ELSE NULL END,'unclassified_spend'
  FROM marketing.meta_insights_daily_scoped i CROSS JOIN bounds b
  LEFT JOIN marketing.meta_identity_accounts a USING(environment,ad_account_id)
  WHERE i.environment=p_environment AND i.campaign_scope='pending' AND i.spend>0
    AND i.metric_date BETWEEN GREATEST(b.since,a.finance_since) AND b.until
    AND (p_enforce OR a.ad_account_id IS NOT NULL)
    AND (a.ad_account_id IS NULL OR i.entity_level='ad')
    AND NOT EXISTS(SELECT 1 FROM marketing.meta_ad_identities d
      WHERE d.environment=i.environment AND d.ad_account_id=i.ad_account_id
        AND d.ad_id=i.entity_id AND i.entity_level='ad'
        AND d.identity_fingerprint IS NOT NULL AND EXISTS(
          SELECT 1 FROM marketing.meta_pending_spend_checks c WHERE c.environment=d.environment
            AND c.ad_account_id=d.ad_account_id AND c.ad_id=d.ad_id
            AND c.identity_fingerprint=d.identity_fingerprint AND c.status='succeeded'
            AND i.metric_date BETWEEN c.window_since AND c.window_until))
$$;

CREATE VIEW marketing.meta_spend_expected AS
SELECT i.environment,i.id,i.ad_account_id,i.campaign_id,i.metric_date,
  CASE WHEN i.metric_date>=COALESCE(a.finance_since,'-infinity'::date)
    THEN i.financial_spend ELSE 0::numeric END scoped_spend,
  CASE WHEN i.metric_date<COALESCE(a.finance_since,'-infinity'::date) THEN 0::numeric
    WHEN a.ad_account_id IS NOT NULL THEN i.financial_spend ELSE i.spend END expected_spend
FROM marketing.meta_insights_daily_scoped i
LEFT JOIN marketing.meta_identity_accounts a USING(environment,ad_account_id)
WHERE i.entity_level='campaign' AND i.account_currency='BRL';

DO $$ DECLARE relation text; role_name text; BEGIN
  FOREACH relation IN ARRAY ARRAY['meta_pending_spend_checks','meta_pending_spend_daily'] LOOP
    EXECUTE format('ALTER TABLE marketing.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON marketing.%I FROM PUBLIC',relation);
  END LOOP;
  REVOKE ALL ON marketing.meta_spend_expected FROM PUBLIC;
  REVOKE ALL ON FUNCTION marketing.meta_pending_campaigns(public.env_t,date,date,boolean) FROM PUBLIC;
  REVOKE ALL ON FUNCTION marketing.meta_pending_spend_coverage(public.env_t,text,text,text) FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','farejador_partner_app','partner_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON marketing.meta_pending_spend_checks,marketing.meta_pending_spend_daily,marketing.meta_spend_expected FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION marketing.meta_pending_campaigns(public.env_t,date,date,boolean) FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION marketing.meta_pending_spend_coverage(public.env_t,text,text,text) FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
