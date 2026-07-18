-- ============================================================
-- 0141_bot_resilience_outbox_dlq.sql
-- Etapa 8: resiliência do Bot/Chatwoot, outbox e DLQ.
--
-- Segurança:
-- - Não altera produção sozinha; precisa ser aplicada no gate de migration.
-- - Reusa ops.atendente_jobs.not_before como agenda de retry/debounce.
-- - Não cria next_attempt_at duplicado.
-- - Não depende de echo_id vindo no webhook; guarda provider_message_id
--   retornado pela API do Chatwoot.
-- ============================================================

BEGIN;

-- agent.turns: status sent_api_ack significa "Chatwoot aceitou pela API".
-- Para os consumidores da casa, sent_api_ack conta como respondido. Para prova
-- forte, delivered_message_id continua reservado ao core.messages confirmado.
ALTER TABLE agent.turns
  ADD COLUMN IF NOT EXISTS chatwoot_message_id BIGINT,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_suspect_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'turns_status_check'
      AND conrelid = 'agent.turns'::regclass
  ) THEN
    ALTER TABLE agent.turns DROP CONSTRAINT turns_status_check;
  END IF;

  ALTER TABLE agent.turns
    ADD CONSTRAINT turns_status_check
    CHECK (status IN ('generated', 'validated', 'sent_api_ack', 'delivered', 'failed', 'blocked'));
END $$;

CREATE INDEX IF NOT EXISTS turns_chatwoot_message_id_idx
  ON agent.turns (environment, chatwoot_message_id)
  WHERE chatwoot_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS turns_responded_v2_idx
  ON agent.turns (environment, conversation_id, created_at DESC)
  WHERE agent_version = 'v2' AND status IN ('sent_api_ack', 'delivered');

COMMENT ON COLUMN agent.turns.chatwoot_message_id IS
  'ID numérico retornado pela API do Chatwoot no envio. Não confundir com delivered_message_id (UUID de core.messages confirmado pelo webhook).';

COMMENT ON COLUMN agent.turns.sent_at IS
  'Momento em que a API do Chatwoot aceitou a mensagem do bot.';

COMMENT ON COLUMN agent.turns.delivery_suspect_at IS
  'Momento a partir do qual o envio aceito pela API ficou suspeito por falta de confirmação via webhook/core.messages.';

-- ops.atendente_jobs: expande status para futura DLQ/superseded explícita,
-- mantendo not_before como a coluna canônica de agenda.
ALTER TABLE ops.atendente_jobs
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS last_error_kind TEXT,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'atendente_jobs_status_check'
      AND conrelid = 'ops.atendente_jobs'::regclass
  ) THEN
    ALTER TABLE ops.atendente_jobs DROP CONSTRAINT atendente_jobs_status_check;
  END IF;

  ALTER TABLE ops.atendente_jobs
    ADD CONSTRAINT atendente_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter', 'superseded'));
END $$;

CREATE TABLE IF NOT EXISTS ops.atendente_job_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  job_id          UUID NOT NULL REFERENCES ops.atendente_jobs(id) ON DELETE CASCADE,
  actor           TEXT NOT NULL DEFAULT 'system',
  reason          TEXT,
  attempt         INTEGER,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  error_code      TEXT,
  error_kind      TEXT,
  error_summary   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS atendente_job_events_job_idx
  ON ops.atendente_job_events (job_id, created_at DESC);

CREATE OR REPLACE FUNCTION ops.guard_atendente_job_event_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'atendente_job_event_immutable' USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS atendente_job_events_immutable ON ops.atendente_job_events;
CREATE TRIGGER atendente_job_events_immutable
  BEFORE UPDATE OR DELETE ON ops.atendente_job_events
  FOR EACH ROW EXECUTE FUNCTION ops.guard_atendente_job_event_immutable();

COMMENT ON TABLE ops.atendente_job_events IS
  'Ledger append-only das transições de jobs do Atendente. Não guardar conteúdo sensível bruto.';

CREATE TABLE IF NOT EXISTS ops.outbound_messages (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment                env_t NOT NULL,
  job_id                     UUID REFERENCES ops.atendente_jobs(id) ON DELETE SET NULL,
  conversation_id            UUID NOT NULL REFERENCES core.conversations(id) ON DELETE CASCADE,
  trigger_message_id         UUID,
  turn_id                    UUID REFERENCES agent.turns(id) ON DELETE SET NULL,
  chatwoot_conversation_id   BIGINT NOT NULL,
  provider_message_id        BIGINT,
  echo_id                    TEXT,
  kind                       TEXT NOT NULL DEFAULT 'agent_text'
                              CHECK (kind IN ('agent_text', 'survey_text', 'photo_text', 'photo_attachment')),
  body                       TEXT NOT NULL,
  body_sha256                TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'sending', 'sent_api_ack', 'delivered', 'superseded', 'failed', 'dead_letter')),
  attempts                   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  not_before                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at                  TIMESTAMPTZ,
  locked_by                  TEXT,
  last_error_code            TEXT,
  last_error_kind            TEXT,
  last_error_summary         TEXT,
  superseded_by_message_id   UUID,
  sent_at                    TIMESTAMPTZ,
  delivered_at               TIMESTAMPTZ,
  delivery_suspect_at        TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, turn_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS outbound_messages_echo_unique
  ON ops.outbound_messages (environment, echo_id)
  WHERE echo_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS outbound_messages_provider_unique
  ON ops.outbound_messages (environment, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbound_messages_pickup_idx
  ON ops.outbound_messages (environment, not_before, status)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS outbound_messages_provider_idx
  ON ops.outbound_messages (environment, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbound_messages_conversation_idx
  ON ops.outbound_messages (environment, conversation_id, created_at DESC);

COMMENT ON TABLE ops.outbound_messages IS
  'Outbox persistente dos envios Chatwoot. O corpo existe para reenvio; telas/DLQ devem expor só resumo sanitizado/hash.';

CREATE TABLE IF NOT EXISTS ops.outbound_message_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  outbound_id     UUID NOT NULL REFERENCES ops.outbound_messages(id) ON DELETE CASCADE,
  actor           TEXT NOT NULL DEFAULT 'system',
  reason          TEXT,
  attempt         INTEGER,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  error_code      TEXT,
  error_kind      TEXT,
  error_summary   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbound_message_events_outbound_idx
  ON ops.outbound_message_events (outbound_id, created_at DESC);

DROP TRIGGER IF EXISTS outbound_message_events_immutable ON ops.outbound_message_events;
CREATE TRIGGER outbound_message_events_immutable
  BEFORE UPDATE OR DELETE ON ops.outbound_message_events
  FOR EACH ROW EXECUTE FUNCTION ops.guard_atendente_job_event_immutable();

COMMENT ON TABLE ops.outbound_message_events IS
  'Ledger append-only das tentativas e transições da outbox, sem conteúdo bruto da mensagem.';

CREATE TABLE IF NOT EXISTS ops.atendente_dead_letters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  job_id          UUID REFERENCES ops.atendente_jobs(id) ON DELETE SET NULL,
  outbound_id     UUID REFERENCES ops.outbound_messages(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES core.conversations(id) ON DELETE SET NULL,
  actor           TEXT,
  reason          TEXT NOT NULL,
  error_code      TEXT,
  error_kind      TEXT,
  error_summary   TEXT,
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS atendente_dead_letters_open_idx
  ON ops.atendente_dead_letters (environment, created_at DESC)
  WHERE resolved_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS atendente_dead_letters_job_open_unique
  ON ops.atendente_dead_letters (environment, job_id)
  WHERE job_id IS NOT NULL AND resolved_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS atendente_dead_letters_outbound_open_unique
  ON ops.atendente_dead_letters (environment, outbound_id)
  WHERE outbound_id IS NOT NULL AND resolved_at IS NULL;

DROP TRIGGER IF EXISTS env_immutable_atendente_job_events ON ops.atendente_job_events;
CREATE TRIGGER env_immutable_atendente_job_events
  BEFORE UPDATE OF environment ON ops.atendente_job_events
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_outbound_messages ON ops.outbound_messages;
CREATE TRIGGER env_immutable_outbound_messages
  BEFORE UPDATE OF environment ON ops.outbound_messages
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_outbound_message_events ON ops.outbound_message_events;
CREATE TRIGGER env_immutable_outbound_message_events
  BEFORE UPDATE OF environment ON ops.outbound_message_events
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_immutable_atendente_dead_letters ON ops.atendente_dead_letters;
CREATE TRIGGER env_immutable_atendente_dead_letters
  BEFORE UPDATE OF environment ON ops.atendente_dead_letters
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS env_match_outbound_conversation ON ops.outbound_messages;
CREATE TRIGGER env_match_outbound_conversation
  BEFORE INSERT OR UPDATE OF conversation_id ON ops.outbound_messages
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','conversations','conversation_id');

DROP TRIGGER IF EXISTS env_match_outbound_job ON ops.outbound_messages;
CREATE TRIGGER env_match_outbound_job
  BEFORE INSERT OR UPDATE OF job_id ON ops.outbound_messages
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('ops','atendente_jobs','job_id');

DROP TRIGGER IF EXISTS env_match_outbound_event_outbound ON ops.outbound_message_events;
CREATE TRIGGER env_match_outbound_event_outbound
  BEFORE INSERT ON ops.outbound_message_events
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('ops','outbound_messages','outbound_id');

DROP TRIGGER IF EXISTS env_match_outbound_turn ON ops.outbound_messages;
CREATE TRIGGER env_match_outbound_turn
  BEFORE INSERT OR UPDATE OF turn_id ON ops.outbound_messages
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('agent','turns','turn_id');

DROP TRIGGER IF EXISTS env_match_dead_letter_conversation ON ops.atendente_dead_letters;
CREATE TRIGGER env_match_dead_letter_conversation
  BEFORE INSERT OR UPDATE OF conversation_id ON ops.atendente_dead_letters
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','conversations','conversation_id');

DROP TRIGGER IF EXISTS env_match_job_event_job ON ops.atendente_job_events;
CREATE TRIGGER env_match_job_event_job
  BEFORE INSERT ON ops.atendente_job_events
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('ops','atendente_jobs','job_id');

DROP TRIGGER IF EXISTS env_match_dead_letter_job ON ops.atendente_dead_letters;
CREATE TRIGGER env_match_dead_letter_job
  BEFORE INSERT OR UPDATE OF job_id ON ops.atendente_dead_letters
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('ops','atendente_jobs','job_id');

DROP TRIGGER IF EXISTS env_match_dead_letter_outbound ON ops.atendente_dead_letters;
CREATE TRIGGER env_match_dead_letter_outbound
  BEFORE INSERT OR UPDATE OF outbound_id ON ops.atendente_dead_letters
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('ops','outbound_messages','outbound_id');

COMMENT ON TABLE ops.atendente_dead_letters IS
  'Fila humana final para falhas do bot/outbox. Não guardar conteúdo sensível bruto.';

-- Tabelas internas do backend: nenhuma porta direta para PUBLIC. Leitura e
-- acao humana passam apenas pelas rotas owner da Matriz.
REVOKE ALL ON TABLE ops.atendente_job_events FROM PUBLIC;
REVOKE ALL ON TABLE ops.outbound_messages FROM PUBLIC;
REVOKE ALL ON TABLE ops.outbound_message_events FROM PUBLIC;
REVOKE ALL ON TABLE ops.atendente_dead_letters FROM PUBLIC;

-- A maquina nova usa not_before e passa a ser a unica dona do retry.
-- Remove o cron legado para impedir dois mecanismos concorrentes no rollout.
DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    FOR v_job_id IN
      SELECT jobid FROM cron.job WHERE jobname = 'requeue-failed-timeouts'
    LOOP
      PERFORM cron.unschedule(v_job_id);
    END LOOP;
  END IF;
END $$;

COMMIT;
