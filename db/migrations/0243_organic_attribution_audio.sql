-- Extensão aditiva: nenhum evento bruto ou mensagem original é alterado.
BEGIN;
ALTER TABLE analytics.meta_comment_decisions
  ADD COLUMN commercial_intent boolean NOT NULL DEFAULT false,
  ADD COLUMN private_body text NOT NULL DEFAULT '',
  ADD COLUMN commercial_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ops.meta_comment_actions ADD COLUMN published_body text;

CREATE TABLE ops.organic_controls (
  environment env_t NOT NULL, platform text NOT NULL CHECK(platform IN ('instagram','facebook')),
  enabled boolean NOT NULL DEFAULT false, activated_at timestamptz,
  verified_inbox_id bigint, verified_at timestamptz, updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(environment,platform)
  ,CHECK (NOT enabled OR (verified_at IS NOT NULL AND verified_inbox_id IS NOT NULL AND activated_at IS NOT NULL))
);
CREATE TABLE ops.organic_outreach (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL,
  comment_id uuid NOT NULL, decision_id uuid NOT NULL,
  platform text NOT NULL CHECK(platform IN ('instagram','facebook')), account_id text NOT NULL,
  recipient_id text, provider_message_id text, body text NOT NULL,
  status text NOT NULL CHECK(status IN ('sending','sent','failed','uncertain','skipped')),
  error_code text, sent_at timestamptz, submitted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status<>'sent' OR (recipient_id IS NOT NULL AND provider_message_id IS NOT NULL AND sent_at IS NOT NULL)),
  UNIQUE(environment,id), UNIQUE(environment,comment_id),
  FOREIGN KEY(environment,comment_id) REFERENCES core.meta_comments(environment,id),
  FOREIGN KEY(environment,comment_id,decision_id) REFERENCES analytics.meta_comment_decisions(environment,comment_id,id)
);
CREATE INDEX organic_outreach_recipient ON ops.organic_outreach(environment,platform,account_id,recipient_id,sent_at);
CREATE UNIQUE INDEX organic_outreach_provider ON ops.organic_outreach(environment,platform,account_id,provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE TABLE ops.organic_meta_events (
  environment env_t NOT NULL, raw_event_id bigint NOT NULL, processed_at timestamptz,
  PRIMARY KEY(environment,raw_event_id),
  FOREIGN KEY(environment,raw_event_id) REFERENCES raw.meta_messaging_events(environment,id)
);
CREATE TABLE ops.organic_inbound (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL,
  platform text NOT NULL CHECK(platform IN ('instagram','facebook')), account_id text NOT NULL,
  sender_id text NOT NULL, provider_message_id text NOT NULL, reply_to_mid text,
  occurred_at timestamptz NOT NULL, raw_event_id bigint NOT NULL, reconciled_at timestamptz,
  conversation_id uuid REFERENCES core.conversations(id), message_id uuid,
  UNIQUE(environment,platform,account_id,provider_message_id),
  FOREIGN KEY(environment,raw_event_id) REFERENCES raw.meta_messaging_events(environment,id)
);
CREATE INDEX organic_inbound_pending ON ops.organic_inbound(environment,occurred_at) WHERE reconciled_at IS NULL;
CREATE TABLE analytics.organic_conversation_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL,
  conversation_id uuid NOT NULL REFERENCES core.conversations(id), outreach_id uuid NOT NULL,
  first_reply_at timestamptz NOT NULL, source_message_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'deterministic', truth_type text NOT NULL DEFAULT 'observed',
  confidence_level text NOT NULL DEFAULT 'high', extractor_version text NOT NULL DEFAULT 'organic-v1',
  source_reference text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), superseded_by uuid,
  UNIQUE(environment,id),
  FOREIGN KEY(environment,outreach_id) REFERENCES ops.organic_outreach(environment,id)
);
CREATE UNIQUE INDEX organic_conversation_current ON analytics.organic_conversation_sources(environment,conversation_id,outreach_id)
  WHERE superseded_by IS NULL;
CREATE TABLE analytics.organic_order_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL,
  order_id uuid NOT NULL REFERENCES commerce.orders(id), conversation_source_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL, source text NOT NULL DEFAULT 'deterministic',
  truth_type text NOT NULL DEFAULT 'observed', confidence_level text NOT NULL DEFAULT 'high',
  extractor_version text NOT NULL DEFAULT 'organic-v1', source_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), superseded_by uuid,
  UNIQUE(environment,id),
  FOREIGN KEY(environment,conversation_source_id) REFERENCES analytics.organic_conversation_sources(environment,id)
);
CREATE UNIQUE INDEX organic_order_current ON analytics.organic_order_sources(environment,order_id) WHERE superseded_by IS NULL;
CREATE TABLE ops.audio_transcription_jobs (
  environment env_t NOT NULL, attachment_id uuid NOT NULL REFERENCES core.message_attachments(id),
  conversation_id uuid NOT NULL REFERENCES core.conversations(id), message_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('processing','done','failed')), error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(environment,attachment_id)
);
CREATE TABLE analytics.audio_transcriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL,
  attachment_id uuid NOT NULL REFERENCES core.message_attachments(id),
  conversation_id uuid NOT NULL REFERENCES core.conversations(id), message_id uuid NOT NULL,
  transcript text NOT NULL, source text NOT NULL DEFAULT 'llm', truth_type text NOT NULL DEFAULT 'inferred',
  confidence_level text NOT NULL CHECK(confidence_level IN ('low','medium','high')),
  extractor_version text NOT NULL, source_reference text NOT NULL, model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), superseded_by uuid,
  UNIQUE(environment,id)
);
CREATE UNIQUE INDEX audio_transcription_current ON analytics.audio_transcriptions(environment,attachment_id)
  WHERE superseded_by IS NULL;
CREATE TABLE ops.stock_interests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL,
  conversation_id uuid NOT NULL REFERENCES core.conversations(id), source_message_id uuid NOT NULL,
  tire_size text NOT NULL, tire_condition text NOT NULL CHECK(tire_condition IN ('novo','meia_vida','remold')),
  phone_e164 text NOT NULL CHECK(phone_e164 ~ '^\+[1-9][0-9]{9,14}$'),
  consent_text text NOT NULL, consent_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','contacted','cancelled')),
  updated_by text NOT NULL DEFAULT 'bot', updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment,source_message_id,tire_size,tire_condition)
);
CREATE UNIQUE INDEX stock_interest_pending ON ops.stock_interests(environment,conversation_id,tire_size,tire_condition)
  WHERE status='pending';
DO $$ DECLARE relation text; role_name text; BEGIN
  FOREACH relation IN ARRAY ARRAY['ops.organic_controls','ops.organic_outreach','ops.organic_meta_events',
    'ops.organic_inbound','analytics.organic_conversation_sources','analytics.organic_order_sources',
    'ops.audio_transcription_jobs','analytics.audio_transcriptions','ops.stock_interests'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC,farejador_partner_app',relation);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON %s FROM %I',relation,role_name);
      END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %s TO service_role',relation);
    END IF;
    EXECUTE format('CREATE TRIGGER environment_immutable BEFORE UPDATE OF environment ON %s
      FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable()',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['ops.organic_inbound','analytics.organic_conversation_sources',
    'ops.audio_transcription_jobs','analytics.audio_transcriptions','ops.stock_interests'] LOOP
    EXECUTE format('CREATE TRIGGER environment_conversation BEFORE INSERT OR UPDATE OF conversation_id ON %s
      FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(''core'',''conversations'',''conversation_id'')',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['ops.audio_transcription_jobs','analytics.audio_transcriptions'] LOOP
    EXECUTE format('CREATE TRIGGER environment_attachment BEFORE INSERT OR UPDATE OF attachment_id ON %s
      FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(''core'',''message_attachments'',''attachment_id'')',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['analytics.organic_conversation_sources','analytics.organic_order_sources','analytics.audio_transcriptions'] LOOP
    EXECUTE format('CREATE TRIGGER derived_immutable BEFORE UPDATE OR DELETE ON %s
      FOR EACH ROW EXECUTE FUNCTION analytics.guard_meta_comment_decision()',relation);
  END LOOP;
END $$;
CREATE TRIGGER organic_order_environment BEFORE INSERT OR UPDATE OF order_id ON analytics.organic_order_sources
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','orders','order_id');
ALTER TABLE analytics.organic_conversation_sources ADD FOREIGN KEY(environment,superseded_by)
  REFERENCES analytics.organic_conversation_sources(environment,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE analytics.organic_order_sources ADD FOREIGN KEY(environment,superseded_by)
  REFERENCES analytics.organic_order_sources(environment,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE analytics.audio_transcriptions ADD FOREIGN KEY(environment,superseded_by)
  REFERENCES analytics.audio_transcriptions(environment,id) DEFERRABLE INITIALLY DEFERRED;

-- Mensagens são particionadas: a referência lógica também valida ambiente e conversa.
CREATE FUNCTION ops.validate_organic_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE message_uuid uuid; BEGIN
  message_uuid := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
  IF message_uuid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM core.messages m
    WHERE m.id=message_uuid AND m.environment=NEW.environment AND m.conversation_id=NEW.conversation_id) THEN
    RAISE EXCEPTION 'organic_message_scope_mismatch';
  END IF;
  IF TG_ARGV[1]='audio' THEN
    IF NOT EXISTS(SELECT 1 FROM core.message_attachments a
      WHERE a.id=NEW.attachment_id AND a.environment=NEW.environment
        AND a.message_id=message_uuid AND a.conversation_id=NEW.conversation_id AND a.file_type='audio') THEN
      RAISE EXCEPTION 'organic_audio_scope_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organic_source_message BEFORE INSERT ON analytics.organic_conversation_sources
  FOR EACH ROW EXECUTE FUNCTION ops.validate_organic_message('source_message_id','text');
CREATE TRIGGER organic_inbound_message BEFORE INSERT OR UPDATE OF message_id,conversation_id ON ops.organic_inbound
  FOR EACH ROW EXECUTE FUNCTION ops.validate_organic_message('message_id','text');
CREATE TRIGGER organic_interest_message BEFORE INSERT ON ops.stock_interests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_organic_message('source_message_id','text');
CREATE TRIGGER audio_job_message BEFORE INSERT ON ops.audio_transcription_jobs
  FOR EACH ROW EXECUTE FUNCTION ops.validate_organic_message('message_id','audio');
CREATE TRIGGER audio_transcription_message BEFORE INSERT ON analytics.audio_transcriptions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_organic_message('message_id','audio');
COMMIT;
