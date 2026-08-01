-- ============================================================
-- 0161_marketing_multichannel_messaging.sql
-- Atribuicao deterministica de anuncios para WhatsApp, Messenger e Instagram.
--
-- Esta migration e somente aditiva:
-- - preserva todos os referrals CTWA existentes;
-- - recebe webhooks Meta em uma inbox raw imutavel e separada do Chatwoot;
-- - guarda referencias Meta pendentes ate o message_id nativo aparecer no core;
-- - nao cria qualquer dependencia do bot com o modulo de Marketing.
-- ============================================================

BEGIN;

-- O source_id nativo do Chatwoot (mid/wamid) permite casar o mesmo evento
-- recebido diretamente da Meta sem usar nome, texto, horario aproximado ou IA.
ALTER TABLE core.messages
  ADD COLUMN IF NOT EXISTS native_message_id TEXT;

CREATE INDEX IF NOT EXISTS messages_native_message_idx
  ON core.messages(environment,native_message_id)
  WHERE native_message_id IS NOT NULL;

COMMENT ON COLUMN core.messages.native_message_id IS
  'ID nativo observado no provedor (Meta mid/wamid), usado para correlacao deterministica.';

-- Inbox propria da Meta. O payload bruto nunca e misturado com raw.raw_events,
-- cuja identidade e definida pelos headers exclusivos do Chatwoot.
CREATE TABLE IF NOT EXISTS raw.meta_messaging_events (
  id                 BIGSERIAL PRIMARY KEY,
  environment        env_t NOT NULL,
  payload_sha256     TEXT NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  signature          TEXT NOT NULL,
  object_type        TEXT NOT NULL,
  payload            JSONB NOT NULL,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_status  TEXT NOT NULL DEFAULT 'pending'
                     CHECK (processing_status IN ('pending','processed','failed','skipped')),
  processing_error   TEXT,
  processed_at       TIMESTAMPTZ,
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  UNIQUE (environment,payload_sha256),
  UNIQUE (environment,id)
);

CREATE INDEX IF NOT EXISTS meta_messaging_events_pending_idx
  ON raw.meta_messaging_events(environment,received_at)
  WHERE processing_status IN ('pending','failed');

CREATE OR REPLACE FUNCTION raw.enforce_meta_messaging_event_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'raw.meta_messaging_events e imutavel: DELETE nao permitido (id=%)',OLD.id
      USING ERRCODE='restrict_violation';
  END IF;
  IF TG_OP='UPDATE' AND (
    OLD.id IS DISTINCT FROM NEW.id OR
    OLD.environment IS DISTINCT FROM NEW.environment OR
    OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256 OR
    OLD.signature IS DISTINCT FROM NEW.signature OR
    OLD.object_type IS DISTINCT FROM NEW.object_type OR
    OLD.payload IS DISTINCT FROM NEW.payload OR
    OLD.received_at IS DISTINCT FROM NEW.received_at
  ) THEN
    RAISE EXCEPTION 'raw.meta_messaging_events e imutavel: coluna protegida (id=%)',OLD.id
      USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meta_messaging_events_immutability_guard
  ON raw.meta_messaging_events;
CREATE TRIGGER meta_messaging_events_immutability_guard
  BEFORE UPDATE OR DELETE ON raw.meta_messaging_events
  FOR EACH ROW EXECUTE FUNCTION raw.enforce_meta_messaging_event_immutability();

-- Generaliza a tabela existente sem reescrever nem invalidar CTWA.
ALTER TABLE marketing.ad_referrals
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS referral_key TEXT,
  ADD COLUMN IF NOT EXISTS user_scoped_id TEXT,
  ADD COLUMN IF NOT EXISTS business_account_id TEXT,
  ADD COLUMN IF NOT EXISTS native_message_id TEXT,
  ADD COLUMN IF NOT EXISTS referral_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE marketing.ad_referrals
   SET referral_key='whatsapp:'||ctwa_clid
 WHERE referral_key IS NULL;

ALTER TABLE marketing.ad_referrals
  ALTER COLUMN referral_key SET NOT NULL,
  ALTER COLUMN ctwa_clid DROP NOT NULL;

ALTER TABLE marketing.ad_referrals
  DROP CONSTRAINT IF EXISTS ad_referrals_channel_check;
ALTER TABLE marketing.ad_referrals
  ADD CONSTRAINT ad_referrals_channel_check
  CHECK (channel IN ('whatsapp','messenger','instagram'));

ALTER TABLE marketing.ad_referrals
  DROP CONSTRAINT IF EXISTS ad_referrals_identity_check;
ALTER TABLE marketing.ad_referrals
  ADD CONSTRAINT ad_referrals_identity_check
  CHECK (
    (channel='whatsapp' AND ctwa_clid IS NOT NULL)
    OR
    (channel='messenger' AND user_scoped_id IS NOT NULL AND business_account_id IS NOT NULL)
    OR
    (channel='instagram' AND user_scoped_id IS NOT NULL AND business_account_id IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS ad_referrals_channel_key_uniq
  ON marketing.ad_referrals(environment,channel,referral_key);
CREATE INDEX IF NOT EXISTS ad_referrals_channel_period_idx
  ON marketing.ad_referrals(environment,channel,captured_at DESC);

COMMENT ON COLUMN marketing.ad_referrals.channel IS
  'Canal observado do clique: whatsapp, messenger ou instagram.';
COMMENT ON COLUMN marketing.ad_referrals.referral_key IS
  'Chave deterministica interna; nao depende de nome, texto ou aproximacao temporal.';
COMMENT ON COLUMN marketing.ad_referrals.user_scoped_id IS
  'PSID do Messenger ou IGSID do Instagram; dado sensivel restrito ao servidor.';

-- Staging estrutural entre o raw da Meta e o message_id nativo do Chatwoot.
CREATE TABLE IF NOT EXISTS marketing.meta_messaging_referrals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment           env_t NOT NULL,
  raw_event_id          BIGINT NOT NULL,
  provider_event_key    TEXT NOT NULL,
  channel               TEXT NOT NULL CHECK (channel IN ('messenger','instagram')),
  provider_message_id   TEXT,
  user_scoped_id        TEXT NOT NULL,
  business_account_id   TEXT NOT NULL,
  ad_id                 TEXT NOT NULL,
  referral_ref          TEXT,
  source_type           TEXT,
  headline              TEXT,
  occurred_at           TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','matched','unmatched')),
  matched_message_id    UUID,
  matched_conversation_id UUID,
  matched_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment,provider_event_key),
  UNIQUE (environment,id),
  FOREIGN KEY (environment,raw_event_id)
    REFERENCES raw.meta_messaging_events(environment,id),
  CHECK (
    (status='matched' AND matched_message_id IS NOT NULL
      AND matched_conversation_id IS NOT NULL AND matched_at IS NOT NULL)
    OR
    (status<>'matched' AND matched_message_id IS NULL
      AND matched_conversation_id IS NULL AND matched_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS meta_messaging_referrals_match_idx
  ON marketing.meta_messaging_referrals(environment,channel,provider_message_id)
  WHERE status='pending' AND provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meta_messaging_referrals_ad_idx
  ON marketing.meta_messaging_referrals(environment,ad_id,occurred_at DESC);

DROP TRIGGER IF EXISTS env_immutable_meta_messaging_referrals
  ON marketing.meta_messaging_referrals;
CREATE TRIGGER env_immutable_meta_messaging_referrals
  BEFORE UPDATE OF environment ON marketing.meta_messaging_referrals
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

REVOKE ALL ON raw.meta_messaging_events FROM PUBLIC;
REVOKE ALL ON marketing.meta_messaging_referrals FROM PUBLIC;

DO $security$
DECLARE
  restricted_role TEXT;
BEGIN
  FOREACH restricted_role IN ARRAY ARRAY['partner_app','farejador_partner_app']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=restricted_role) THEN
      EXECUTE format('REVOKE ALL ON raw.meta_messaging_events FROM %I',restricted_role);
      EXECUTE format('REVOKE ALL ON marketing.meta_messaging_referrals FROM %I',restricted_role);
    END IF;
  END LOOP;
END
$security$;

COMMENT ON TABLE raw.meta_messaging_events IS
  'Webhooks Meta brutos, imutaveis e isolados dos eventos Chatwoot.';
COMMENT ON TABLE marketing.meta_messaging_referrals IS
  'Referral de anuncio Meta aguardando ou registrando casamento deterministico com core.messages.';
COMMENT ON TABLE marketing.ad_referrals IS
  'Referral observado de anuncio em WhatsApp, Messenger ou Instagram; uma conversa pode ter varios cliques.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM marketing.ad_referrals
     WHERE referral_key IS NULL OR channel NOT IN ('whatsapp','messenger','instagram')
  ) THEN
    RAISE EXCEPTION '0161: referral multicanal invalido';
  END IF;
END $$;

COMMIT;
