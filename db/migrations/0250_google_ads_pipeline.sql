-- Google Ads: coleta por entidade, clique consentido, atribuicao versionada e Data Manager outbox.
-- Nenhuma alteracao no esquema ou nos dados da Meta, raw ou analytics.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_environment_id_google_uniq ON core.conversations(environment,id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_environment_id_google_uniq ON commerce.orders(environment,id);

CREATE TABLE marketing.google_accounts (
 environment env_t NOT NULL, account_id text NOT NULL CHECK(account_id ~ '^\d{10}$'),
 name text NOT NULL, currency text NOT NULL CHECK(currency='BRL'), time_zone text NOT NULL,
 scope text NOT NULL CHECK(scope IN ('account','campaigns')), finance_since date,
 last_sync_at timestamptz, PRIMARY KEY(environment,account_id)
);
CREATE TABLE marketing.google_campaigns (
 environment env_t NOT NULL, account_id text NOT NULL, campaign_id text NOT NULL CHECK(campaign_id ~ '^\d+$'),
 name text NOT NULL, status text NOT NULL, channel_type text NOT NULL, owned boolean NOT NULL,
 PRIMARY KEY(environment,account_id,campaign_id),
 FOREIGN KEY(environment,account_id) REFERENCES marketing.google_accounts(environment,account_id)
);
CREATE TABLE marketing.google_ads (
 environment env_t NOT NULL, account_id text NOT NULL, ad_group_id text NOT NULL CHECK(ad_group_id ~ '^\d+$'),
 ad_id text NOT NULL CHECK(ad_id ~ '^\d+$'), campaign_id text NOT NULL,
 name text NOT NULL, status text NOT NULL, format text NOT NULL,
 headlines jsonb NOT NULL DEFAULT '[]', descriptions jsonb NOT NULL DEFAULT '[]', final_url text,
 PRIMARY KEY(environment,account_id,ad_group_id,ad_id),
 FOREIGN KEY(environment,account_id,campaign_id) REFERENCES marketing.google_campaigns(environment,account_id,campaign_id)
);
CREATE TABLE marketing.google_insights_daily (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL, account_id text NOT NULL,
 campaign_id text NOT NULL, entity_level text NOT NULL CHECK(entity_level IN ('campaign','ad')),
 entity_id text NOT NULL, metric_date date NOT NULL, cost_micros bigint NOT NULL CHECK(cost_micros>=0),
 impressions bigint NOT NULL CHECK(impressions>=0), clicks bigint NOT NULL CHECK(clicks>=0),
 conversions numeric NOT NULL CHECK(conversions>=0 AND conversions<1e15),
 collected_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(environment,account_id,entity_level,entity_id,metric_date), UNIQUE(environment,id),
 FOREIGN KEY(environment,account_id,campaign_id) REFERENCES marketing.google_campaigns(environment,account_id,campaign_id)
);
CREATE INDEX google_insights_period_idx ON marketing.google_insights_daily(environment,account_id,entity_level,metric_date);
CREATE TABLE marketing.google_clicks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL, account_id text NOT NULL,
 campaign_id text NOT NULL, ad_group_id text NOT NULL, ad_id text NOT NULL,
 reference text NOT NULL CHECK(reference ~ '^2W-G[a-f0-9]{32}$'),
 identifier_type text NOT NULL CHECK(identifier_type IN ('gclid','gbraid','wbraid')),
 identifier text NOT NULL CHECK(length(identifier) BETWEEN 1 AND 512), identifier_hash text NOT NULL,
 consent_ad_user_data boolean NOT NULL CHECK(consent_ad_user_data),
 consent_ad_personalization boolean NOT NULL DEFAULT false,
 destination text NOT NULL CHECK(destination IN ('whatsapp','web')), captured_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(environment,reference), UNIQUE(environment,account_id,identifier_hash), UNIQUE(environment,id),
 FOREIGN KEY(environment,account_id,ad_group_id,ad_id) REFERENCES marketing.google_ads(environment,account_id,ad_group_id,ad_id)
);
CREATE TABLE marketing.google_click_conversations (
 environment env_t NOT NULL, click_id uuid NOT NULL, conversation_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('message_reference','web_custom_attribute')),
 observed_at timestamptz NOT NULL, PRIMARY KEY(environment,click_id),
 FOREIGN KEY(environment,click_id) REFERENCES marketing.google_clicks(environment,id),
 FOREIGN KEY(environment,conversation_id) REFERENCES core.conversations(environment,id)
);
CREATE INDEX google_click_conversation_idx ON marketing.google_click_conversations(environment,conversation_id);
CREATE TABLE marketing.google_order_attributions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL,
 order_id uuid NOT NULL, click_id uuid NOT NULL, conversation_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('active','revoked')), realized_at timestamptz NOT NULL,
 source_type text NOT NULL DEFAULT 'deterministic_google_click', truth_type text NOT NULL CHECK(truth_type IN ('observed','corrected')),
 confidence_level numeric(3,2) NOT NULL CHECK(confidence_level BETWEEN 0 AND 1),
 source_reference jsonb NOT NULL, extractor_version text NOT NULL, computed_at timestamptz NOT NULL DEFAULT now(),
 superseded_by uuid, UNIQUE(environment,id), CHECK(superseded_by IS NULL OR superseded_by<>id),
 FOREIGN KEY(environment,order_id) REFERENCES commerce.orders(environment,id),
 FOREIGN KEY(environment,click_id) REFERENCES marketing.google_clicks(environment,id),
 FOREIGN KEY(environment,conversation_id) REFERENCES core.conversations(environment,id),
 FOREIGN KEY(environment,superseded_by) REFERENCES marketing.google_order_attributions(environment,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX google_attribution_order_uniq ON marketing.google_order_attributions(environment,order_id) WHERE status='active' AND superseded_by IS NULL;
CREATE UNIQUE INDEX google_attribution_click_uniq ON marketing.google_order_attributions(environment,click_id) WHERE status='active' AND superseded_by IS NULL;
CREATE TABLE marketing.google_conversion_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL, attribution_id uuid NOT NULL,
 order_id uuid NOT NULL, action_id text NOT NULL CHECK(action_id ~ '^\d+$'),
 transaction_id text NOT NULL, status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','processing','accepted','sent','failed','suppressed','dead_letter','review')),
 request_id text, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 not_before timestamptz NOT NULL DEFAULT now(), locked_at timestamptz,
 last_error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 UNIQUE(environment,order_id,action_id), UNIQUE(environment,transaction_id,action_id),
 FOREIGN KEY(environment,attribution_id) REFERENCES marketing.google_order_attributions(environment,id),
 FOREIGN KEY(environment,order_id) REFERENCES commerce.orders(environment,id)
);
CREATE INDEX google_outbox_pickup_idx ON marketing.google_conversion_outbox(environment,not_before) WHERE status IN ('pending','failed','accepted');

-- Integridade de ambiente mesmo para o owner e tabelas auxiliares.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['google_accounts','google_campaigns','google_ads','google_insights_daily','google_clicks','google_click_conversations','google_order_attributions','google_conversion_outbox'] LOOP
   EXECUTE format('CREATE TRIGGER environment_immutable BEFORE UPDATE ON marketing.%I FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable()',t);
   EXECUTE format('REVOKE ALL ON marketing.%I FROM PUBLIC',t);
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='partner_app') THEN
     EXECUTE format('REVOKE ALL ON marketing.%I FROM partner_app',t);
   END IF;
 END LOOP;
END $$;
CREATE FUNCTION marketing.guard_google_attribution_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'superseded_by') IS DISTINCT FROM (to_jsonb(OLD)-'superseded_by')
   OR OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL THEN
   RAISE EXCEPTION 'google attribution history is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER google_attribution_history BEFORE UPDATE OR DELETE ON marketing.google_order_attributions
 FOR EACH ROW EXECUTE FUNCTION marketing.guard_google_attribution_history();
COMMENT ON TABLE marketing.google_clicks IS 'Somente identificadores de clique autorizados. Sem telefone, IP, email ou fingerprint.';
COMMENT ON TABLE marketing.google_conversion_outbox IS 'Uma venda por transaction_id. accepted aguarda confirmacao; review bloqueia reenvio ambiguo.';
COMMIT;
