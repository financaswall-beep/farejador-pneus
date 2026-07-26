-- ============================================================
-- 0144_marketing_attribution_pipeline.sql
-- Marketing: Insights persistidos, referrals CTWA, atribuicao e CAPI outbox.
--
-- Regras:
-- - toda tabela separa prod/test por environment;
-- - referral observado permanece ligado a conversa e mensagem de origem;
-- - atribuicao derivada e versionada, sem casamento por telefone;
-- - CAPI nunca participa da transacao da venda;
-- - nenhuma permissao e concedida ao portal parceiro.
-- ============================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS marketing;
COMMENT ON SCHEMA marketing IS
  'Integracao deterministica de midia paga: coleta Meta, CTWA, atribuicao e entrega CAPI.';

CREATE TABLE IF NOT EXISTS marketing.meta_sync_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  source          TEXT NOT NULL DEFAULT 'meta'
                  CHECK (source IN ('meta')),
  trigger_type    TEXT NOT NULL
                  CHECK (trigger_type IN ('startup','scheduled','manual')),
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','failed')),
  window_since    DATE NOT NULL,
  window_until    DATE NOT NULL,
  levels          TEXT[] NOT NULL DEFAULT ARRAY['campaign']::TEXT[],
  rows_upserted   INTEGER NOT NULL DEFAULT 0 CHECK (rows_upserted >= 0),
  error_code      TEXT,
  error_summary   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  CHECK (window_since <= window_until),
  UNIQUE (environment, id)
);

CREATE INDEX IF NOT EXISTS meta_sync_runs_recent_idx
  ON marketing.meta_sync_runs(environment, started_at DESC);

CREATE TABLE IF NOT EXISTS marketing.meta_insights_daily (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment              env_t NOT NULL,
  sync_run_id              UUID REFERENCES marketing.meta_sync_runs(id) ON DELETE SET NULL,
  ad_account_id            TEXT NOT NULL,
  api_version              TEXT NOT NULL,
  account_currency         TEXT NOT NULL,
  entity_level             TEXT NOT NULL
                           CHECK (entity_level IN ('campaign','ad')),
  entity_id                TEXT NOT NULL,
  entity_name              TEXT,
  campaign_id              TEXT NOT NULL,
  campaign_name            TEXT,
  adset_id                 TEXT,
  adset_name               TEXT,
  metric_date              DATE NOT NULL,
  spend                    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (spend >= 0),
  impressions              BIGINT NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks                   BIGINT NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  reach                    BIGINT CHECK (reach IS NULL OR reach >= 0),
  conversations            INTEGER NOT NULL DEFAULT 0 CHECK (conversations >= 0),
  conversation_action_type TEXT,
  actions_raw              JSONB NOT NULL DEFAULT '[]'::jsonb,
  collected_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, ad_account_id, entity_level, entity_id, metric_date),
  UNIQUE (environment, id)
);

CREATE INDEX IF NOT EXISTS meta_insights_daily_period_idx
  ON marketing.meta_insights_daily(environment, ad_account_id, entity_level, metric_date);
CREATE INDEX IF NOT EXISTS meta_insights_daily_campaign_idx
  ON marketing.meta_insights_daily(environment, campaign_id, metric_date);

CREATE TABLE IF NOT EXISTS marketing.ad_referrals (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment            env_t NOT NULL,
  conversation_id        UUID NOT NULL REFERENCES core.conversations(id),
  source_message_id      UUID NOT NULL,
  source_message_sent_at TIMESTAMPTZ NOT NULL,
  ctwa_clid              TEXT NOT NULL,
  source_id              TEXT,
  source_url             TEXT,
  source_type            TEXT,
  headline               TEXT,
  captured_at            TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, ctwa_clid),
  UNIQUE (environment, source_message_id),
  UNIQUE (environment, id)
);

CREATE INDEX IF NOT EXISTS ad_referrals_conversation_idx
  ON marketing.ad_referrals(environment, conversation_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS ad_referrals_source_idx
  ON marketing.ad_referrals(environment, source_id)
  WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketing.order_attributions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment        env_t NOT NULL,
  order_id           UUID NOT NULL REFERENCES commerce.orders(id),
  referral_id        UUID NOT NULL REFERENCES marketing.ad_referrals(id),
  conversation_id    UUID NOT NULL REFERENCES core.conversations(id),
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','revoked')),
  attribution_model  TEXT NOT NULL,
  rule_version       INTEGER NOT NULL CHECK (rule_version > 0),
  source_type        TEXT NOT NULL,
  truth_type         TEXT NOT NULL
                     CHECK (truth_type IN ('observed','inferred','predicted','corrected')),
  confidence_level   NUMERIC(3,2) NOT NULL
                     CHECK (confidence_level BETWEEN 0 AND 1),
  source_reference   JSONB NOT NULL,
  extractor_version  TEXT NOT NULL,
  realized_at        TIMESTAMPTZ NOT NULL,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by      UUID REFERENCES marketing.order_attributions(id)
                     DEFERRABLE INITIALLY DEFERRED,
  CHECK (superseded_by IS NULL OR superseded_by <> id),
  UNIQUE (environment, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS order_attributions_active_order_uniq
  ON marketing.order_attributions(environment, order_id)
  WHERE status = 'active' AND superseded_by IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_attributions_active_referral_uniq
  ON marketing.order_attributions(environment, referral_id)
  WHERE status = 'active' AND superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS order_attributions_period_idx
  ON marketing.order_attributions(environment, realized_at DESC)
  WHERE status = 'active' AND superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS order_attributions_conversation_idx
  ON marketing.order_attributions(environment, conversation_id, realized_at DESC);
CREATE INDEX IF NOT EXISTS order_attributions_superseded_idx
  ON marketing.order_attributions(superseded_by)
  WHERE superseded_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketing.capi_outbox (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment        env_t NOT NULL,
  attribution_id     UUID NOT NULL REFERENCES marketing.order_attributions(id),
  event_name         TEXT NOT NULL DEFAULT 'Purchase',
  event_id           TEXT NOT NULL,
  payload            JSONB NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','processing','sent','failed','dead_letter')),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  not_before         TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at          TIMESTAMPTZ,
  locked_by          TEXT,
  fbtrace_id         TEXT,
  events_received    INTEGER,
  last_error_code    TEXT,
  last_error_kind    TEXT,
  last_error_summary TEXT,
  dead_lettered_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at            TIMESTAMPTZ,
  UNIQUE (environment, event_name, event_id),
  UNIQUE (environment, id)
);

CREATE INDEX IF NOT EXISTS capi_outbox_pickup_idx
  ON marketing.capi_outbox(environment, not_before, created_at)
  WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS capi_outbox_attribution_idx
  ON marketing.capi_outbox(environment, attribution_id);
CREATE INDEX IF NOT EXISTS capi_outbox_dead_letter_idx
  ON marketing.capi_outbox(environment, dead_lettered_at DESC)
  WHERE status = 'dead_letter';

-- Ambiente e referencias cruzadas.
DROP TRIGGER IF EXISTS env_immutable_meta_sync_runs ON marketing.meta_sync_runs;
CREATE TRIGGER env_immutable_meta_sync_runs
  BEFORE UPDATE OF environment ON marketing.meta_sync_runs
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_meta_insights_daily ON marketing.meta_insights_daily;
CREATE TRIGGER env_immutable_meta_insights_daily
  BEFORE UPDATE OF environment ON marketing.meta_insights_daily
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_ad_referrals ON marketing.ad_referrals;
CREATE TRIGGER env_immutable_ad_referrals
  BEFORE UPDATE OF environment ON marketing.ad_referrals
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_order_attributions ON marketing.order_attributions;
CREATE TRIGGER env_immutable_order_attributions
  BEFORE UPDATE OF environment ON marketing.order_attributions
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_capi_outbox ON marketing.capi_outbox;
CREATE TRIGGER env_immutable_capi_outbox
  BEFORE UPDATE OF environment ON marketing.capi_outbox
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_match_meta_insight_sync ON marketing.meta_insights_daily;
CREATE TRIGGER env_match_meta_insight_sync
  BEFORE INSERT OR UPDATE OF sync_run_id ON marketing.meta_insights_daily
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('marketing','meta_sync_runs','sync_run_id');

DROP TRIGGER IF EXISTS env_match_ad_referral_conversation ON marketing.ad_referrals;
CREATE TRIGGER env_match_ad_referral_conversation
  BEFORE INSERT OR UPDATE OF conversation_id ON marketing.ad_referrals
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','conversations','conversation_id');

DROP TRIGGER IF EXISTS env_match_ad_referral_message ON marketing.ad_referrals;
CREATE TRIGGER env_match_ad_referral_message
  BEFORE INSERT OR UPDATE OF source_message_id ON marketing.ad_referrals
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','messages','source_message_id');

DROP TRIGGER IF EXISTS env_match_order_attribution_order ON marketing.order_attributions;
CREATE TRIGGER env_match_order_attribution_order
  BEFORE INSERT OR UPDATE OF order_id ON marketing.order_attributions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','orders','order_id');

DROP TRIGGER IF EXISTS env_match_order_attribution_referral ON marketing.order_attributions;
CREATE TRIGGER env_match_order_attribution_referral
  BEFORE INSERT OR UPDATE OF referral_id ON marketing.order_attributions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('marketing','ad_referrals','referral_id');

DROP TRIGGER IF EXISTS env_match_order_attribution_conversation ON marketing.order_attributions;
CREATE TRIGGER env_match_order_attribution_conversation
  BEFORE INSERT OR UPDATE OF conversation_id ON marketing.order_attributions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','conversations','conversation_id');

DROP TRIGGER IF EXISTS env_match_order_attribution_superseded ON marketing.order_attributions;
CREATE TRIGGER env_match_order_attribution_superseded
  BEFORE INSERT OR UPDATE OF superseded_by ON marketing.order_attributions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('marketing','order_attributions','superseded_by');

DROP TRIGGER IF EXISTS env_match_capi_attribution ON marketing.capi_outbox;
CREATE TRIGGER env_match_capi_attribution
  BEFORE INSERT OR UPDATE OF attribution_id ON marketing.capi_outbox
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('marketing','order_attributions','attribution_id');

-- Backfill deterministico. Se o Chatwoot nunca enviou referral, insere zero linhas.
INSERT INTO marketing.ad_referrals (
  environment, conversation_id, source_message_id, source_message_sent_at,
  ctwa_clid, source_id, source_url, source_type, headline, captured_at
)
SELECT DISTINCT ON (m.environment, m.content_attributes #>> '{referral,ctwa_clid}')
  m.environment,
  m.conversation_id,
  m.id,
  m.sent_at,
  m.content_attributes #>> '{referral,ctwa_clid}',
  NULLIF(m.content_attributes #>> '{referral,source_id}', ''),
  NULLIF(m.content_attributes #>> '{referral,source_url}', ''),
  NULLIF(m.content_attributes #>> '{referral,source_type}', ''),
  NULLIF(m.content_attributes #>> '{referral,headline}', ''),
  m.sent_at
FROM core.messages m
WHERE m.sender_type = 'contact'
  AND m.is_private = false
  AND COALESCE(m.content_attributes #>> '{referral,ctwa_clid}', '') <> ''
ORDER BY m.environment, m.content_attributes #>> '{referral,ctwa_clid}', m.sent_at
ON CONFLICT DO NOTHING;

COMMENT ON TABLE marketing.meta_insights_daily IS
  'Metricas brutas diarias da Meta. Upsert substitui o retrato do dia; nunca soma recoleta.';
COMMENT ON TABLE marketing.ad_referrals IS
  'Referral CTWA observado e normalizado. Uma conversa pode ter varios cliques ao longo do tempo.';
COMMENT ON TABLE marketing.order_attributions IS
  'Ledger versionado clique->venda. Atribuicao ativa usa ultimo clique em 7 dias e um clique para uma venda.';
COMMENT ON TABLE marketing.capi_outbox IS
  'Fila duravel CAPI. Payload congelado e sensivel; nunca expor integralmente em tela ou log.';

REVOKE ALL ON SCHEMA marketing FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA marketing FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA marketing FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_app') THEN
    REVOKE ALL ON SCHEMA marketing FROM partner_app;
    REVOKE ALL ON ALL TABLES IN SCHEMA marketing FROM partner_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA marketing FROM partner_app;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'marketing' AND table_name = 'order_attributions'
  ) THEN
    RAISE EXCEPTION '0144: marketing.order_attributions ausente';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM marketing.ad_referrals r
    JOIN core.conversations c ON c.id = r.conversation_id
    WHERE r.environment <> c.environment
  ) THEN
    RAISE EXCEPTION '0144: environment contaminado em ad_referrals';
  END IF;
END $$;

COMMIT;
