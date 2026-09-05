-- Pausa silenciosa por conversa. Nenhuma mensagem pública é criada por este controle.
CREATE TABLE IF NOT EXISTS ops.conversation_bot_control (
  environment env_t NOT NULL,
  conversation_id UUID NOT NULL REFERENCES core.conversations(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','human')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version>=0),
  resumed_at TIMESTAMPTZ,
  last_human_at TIMESTAMPTZ,
  last_human_message_id BIGINT,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment,conversation_id)
);

CREATE TABLE IF NOT EXISTS ops.conversation_bot_control_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  conversation_id UUID NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('takeover','resume','human_message')),
  actor TEXT NOT NULL,
  chatwoot_message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (environment,conversation_id)
    REFERENCES ops.conversation_bot_control(environment,conversation_id) ON DELETE RESTRICT,
  UNIQUE (environment,conversation_id,version)
);

-- A ativação não reinterpreta mensagens históricas como intervenções novas.
-- Também impede que a retomada dispare rascunhos anteriores à ativação.
INSERT INTO ops.conversation_bot_control(environment,conversation_id,resumed_at)
SELECT environment,id,now() FROM core.conversations WHERE deleted_at IS NULL
ON CONFLICT (environment,conversation_id) DO NOTHING;

DROP TRIGGER IF EXISTS conversation_bot_control_environment ON ops.conversation_bot_control;
CREATE TRIGGER conversation_bot_control_environment
BEFORE INSERT OR UPDATE OF environment,conversation_id ON ops.conversation_bot_control
FOR EACH ROW EXECUTE FUNCTION ops.guard_customer_lead_board_environment();

DROP TRIGGER IF EXISTS conversation_bot_control_environment_immutable ON ops.conversation_bot_control;
CREATE TRIGGER conversation_bot_control_environment_immutable
BEFORE UPDATE OF environment ON ops.conversation_bot_control
FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DROP TRIGGER IF EXISTS conversation_bot_control_events_immutable ON ops.conversation_bot_control_events;
CREATE TRIGGER conversation_bot_control_events_immutable
BEFORE UPDATE OR DELETE ON ops.conversation_bot_control_events
FOR EACH ROW EXECUTE FUNCTION ops.guard_atendente_job_event_immutable();

CREATE INDEX IF NOT EXISTS conversation_bot_control_human_idx
ON ops.conversation_bot_control(environment,updated_at DESC) WHERE mode='human';

REVOKE ALL ON ops.conversation_bot_control,ops.conversation_bot_control_events FROM PUBLIC;
COMMENT ON TABLE ops.conversation_bot_control IS
  'Controle interno por conversa. Humano mantém bot pausado até retomada explícita; não envia avisos ao cliente.';
