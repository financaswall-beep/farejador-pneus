-- Automatic ownership is activated only by a complete, successful Meta sync.
-- Imported metrics and manual classifications remain available for audit.
BEGIN;

CREATE TABLE marketing.meta_identity_accounts (
  environment public.env_t NOT NULL,
  ad_account_id text NOT NULL,
  sync_run_id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment,ad_account_id),
  FOREIGN KEY (environment,sync_run_id) REFERENCES marketing.meta_sync_runs(environment,id)
);
CREATE TABLE marketing.meta_ad_identities (
  environment public.env_t NOT NULL,
  ad_account_id text NOT NULL,
  ad_id text NOT NULL,
  campaign_id text NOT NULL,
  facebook_page_id text,
  instagram_user_id text,
  scope text NOT NULL CHECK (scope IN ('matrix','external','pending')),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment,ad_account_id,ad_id),
  FOREIGN KEY (environment,ad_account_id)
    REFERENCES marketing.meta_identity_accounts(environment,ad_account_id)
);
CREATE TRIGGER env_immutable_meta_identity_accounts BEFORE UPDATE OF environment
 ON marketing.meta_identity_accounts FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
CREATE TRIGGER env_immutable_meta_ad_identities BEFORE UPDATE OF environment
 ON marketing.meta_ad_identities FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

CREATE INDEX meta_ad_identity_campaign_idx
  ON marketing.meta_ad_identities(environment,ad_account_id,campaign_id);

CREATE VIEW marketing.effective_campaign_scopes AS
SELECT s.id,s.environment,s.ad_account_id,s.campaign_id,s.campaign_name,
  CASE WHEN a.ad_account_id IS NULL THEN s.scope
    WHEN EXISTS (SELECT 1 FROM marketing.meta_ad_identities d
      WHERE d.environment=s.environment AND d.ad_account_id=s.ad_account_id
        AND d.campaign_id=s.campaign_id AND d.scope='matrix') THEN 'matrix'
    WHEN EXISTS (SELECT 1 FROM marketing.meta_ad_identities d
      WHERE d.environment=s.environment AND d.ad_account_id=s.ad_account_id AND d.campaign_id=s.campaign_id)
      AND NOT EXISTS (SELECT 1 FROM marketing.meta_ad_identities d
        WHERE d.environment=s.environment AND d.ad_account_id=s.ad_account_id
          AND d.campaign_id=s.campaign_id AND d.scope<>'external') THEN 'external'
    ELSE 'pending' END AS scope,
  s.classification_reason,s.classified_by,s.classified_at,s.created_at,s.updated_at
FROM marketing.campaign_scopes s
LEFT JOIN marketing.meta_identity_accounts a USING (environment,ad_account_id);

-- Unresolved ads in an activated account never inherit a campaign's ownership.
CREATE FUNCTION marketing.meta_ad_scope_allowed(p_environment public.env_t,p_account text,p_ad text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM marketing.meta_identity_accounts
    WHERE environment=p_environment AND (p_account IS NULL OR ad_account_id=p_account)) THEN true
  ELSE EXISTS (SELECT 1 FROM marketing.meta_ad_identities
    WHERE environment=p_environment AND ad_account_id=p_account AND ad_id=p_ad AND scope='matrix') END
$$;

CREATE OR REPLACE VIEW marketing.meta_insights_daily_scoped AS
WITH eligible AS (
  SELECT i.* FROM marketing.meta_insights_daily i
  JOIN marketing.meta_ad_identities d ON d.environment=i.environment
    AND d.ad_account_id=i.ad_account_id AND d.ad_id=i.entity_id
    AND d.campaign_id=i.campaign_id AND d.scope='matrix'
  WHERE i.entity_level='ad'
), totals AS (
  SELECT environment,ad_account_id,campaign_id,metric_date,
    sum(spend) spend,sum(impressions) impressions,sum(clicks) clicks,sum(conversations) conversations
  FROM eligible GROUP BY environment,ad_account_id,campaign_id,metric_date
), action_totals AS (
  SELECT environment,ad_account_id,campaign_id,metric_date,act->>'action_type' action_type,
    sum((act->>'value')::numeric) value
  FROM eligible CROSS JOIN LATERAL jsonb_array_elements(actions_raw) act
  WHERE act->>'value' ~ '^[0-9]+([.][0-9]+)?$'
  GROUP BY environment,ad_account_id,campaign_id,metric_date,act->>'action_type'
), actions AS (
  SELECT environment,ad_account_id,campaign_id,metric_date,
    jsonb_agg(jsonb_build_object('action_type',action_type,'value',value)) items
  FROM action_totals GROUP BY environment,ad_account_id,campaign_id,metric_date
)
SELECT adjusted.*,s.id campaign_scope_id,ownership.scope campaign_scope,
  CASE WHEN ownership.scope='matrix' THEN adjusted.spend ELSE 0 END financial_spend,
  s.classified_at scope_classified_at
FROM marketing.meta_insights_daily i
LEFT JOIN marketing.meta_identity_accounts a USING (environment,ad_account_id)
LEFT JOIN marketing.effective_campaign_scopes s USING (environment,ad_account_id,campaign_id)
LEFT JOIN marketing.meta_ad_identities d ON d.environment=i.environment
  AND d.ad_account_id=i.ad_account_id AND d.ad_id=i.entity_id AND d.campaign_id=i.campaign_id
LEFT JOIN totals t ON t.environment=i.environment AND t.ad_account_id=i.ad_account_id
  AND t.campaign_id=i.campaign_id AND t.metric_date=i.metric_date
LEFT JOIN actions x ON x.environment=i.environment AND x.ad_account_id=i.ad_account_id
  AND x.campaign_id=i.campaign_id AND x.metric_date=i.metric_date
CROSS JOIN LATERAL (SELECT CASE WHEN a.ad_account_id IS NOT NULL AND i.entity_level='ad'
  THEN COALESCE(d.scope,'pending') ELSE COALESCE(s.scope,'pending') END scope) ownership
CROSS JOIN LATERAL jsonb_populate_record(NULL::marketing.meta_insights_daily,
  to_jsonb(i) || CASE WHEN a.ad_account_id IS NOT NULL AND i.entity_level='campaign'
    AND ownership.scope='matrix' THEN jsonb_build_object(
      'spend',COALESCE(t.spend,0),'impressions',COALESCE(t.impressions,0),
      'clicks',COALESCE(t.clicks,0),'conversations',COALESCE(t.conversations,0),
      'reach',NULL,'actions_raw',COALESCE(x.items,'[]'::jsonb))
    ELSE '{}'::jsonb END) adjusted;

REVOKE ALL ON marketing.meta_identity_accounts,marketing.meta_ad_identities,
  marketing.effective_campaign_scopes FROM PUBLIC;
REVOKE ALL ON FUNCTION marketing.meta_ad_scope_allowed(public.env_t,text,text) FROM PUBLIC;
COMMIT;
