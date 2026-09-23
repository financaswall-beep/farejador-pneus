-- Atendimento humano no app: reutiliza a outbox e preserva core/raw somente leitura.
BEGIN;
ALTER TABLE ops.outbound_messages DROP CONSTRAINT outbound_messages_kind_check;
ALTER TABLE ops.outbound_messages ADD CONSTRAINT outbound_messages_kind_check CHECK (kind IN (
  'agent_text','survey_text','photo_text','photo_attachment','conversation_resolution',
  'operator_text','operator_attachment'
));
CREATE TABLE ops.operator_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  conversation_id uuid NOT NULL REFERENCES core.conversations(id) ON DELETE CASCADE,
  outbound_id uuid NOT NULL REFERENCES ops.outbound_messages(id) ON DELETE CASCADE,
  client_token uuid NOT NULL,
  actor text NOT NULL,
  photo_request_id uuid REFERENCES commerce.photo_requests(id) ON DELETE SET NULL,
  fingerprint text NOT NULL,
  filename text,
  mime text,
  bytes bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment,conversation_id,client_token),
  UNIQUE(environment,outbound_id),
  CHECK ((bytes IS NULL AND mime IS NULL AND filename IS NULL) OR
    (bytes IS NOT NULL AND mime IS NOT NULL AND filename IS NOT NULL AND octet_length(bytes) BETWEEN 1 AND 16777216))
);
ALTER TABLE ops.operator_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.operator_messages FROM PUBLIC,farejador_partner_app;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ops.operator_messages FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON ops.operator_messages TO service_role;
  END IF;
END $$;
CREATE INDEX operator_messages_conversation ON ops.operator_messages(environment,conversation_id,created_at);
CREATE TRIGGER env_immutable_operator_messages BEFORE UPDATE OF environment ON ops.operator_messages
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
CREATE TRIGGER env_match_operator_conversation BEFORE INSERT OR UPDATE OF conversation_id ON ops.operator_messages
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','conversations','conversation_id');
CREATE TRIGGER env_match_operator_outbound BEFORE INSERT OR UPDATE OF outbound_id ON ops.operator_messages
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('ops','outbound_messages','outbound_id');
CREATE TRIGGER env_match_operator_photo BEFORE INSERT OR UPDATE OF photo_request_id ON ops.operator_messages
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','photo_requests','photo_request_id');
-- A cópia para envio não precisa sobreviver ao anexo confirmado no Chatwoot.
CREATE FUNCTION ops.prune_operator_media(p_now timestamptz DEFAULT now()) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core AS $$
DECLARE removed integer;
BEGIN
  UPDATE ops.operator_messages op SET bytes=NULL,mime=NULL,filename=NULL
    FROM ops.outbound_messages o
    WHERE o.environment=op.environment AND o.id=op.outbound_id AND op.bytes IS NOT NULL
      AND o.status IN ('sent_api_ack','delivered') AND o.sent_at<p_now-interval '7 days'
      AND EXISTS(SELECT 1 FROM core.messages m JOIN core.message_attachments a
        ON a.environment=m.environment AND a.message_id=m.id AND a.data_url IS NOT NULL
        WHERE m.environment=o.environment AND m.conversation_id=o.conversation_id
          AND m.deleted_at IS NULL AND (m.chatwoot_message_id=o.provider_message_id
            OR m.echo_id=o.echo_id OR m.content_attributes->>'farejador_echo_id'=o.echo_id));
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION ops.prune_operator_media(timestamptz) FROM PUBLIC;
SELECT cron.schedule('farejador-operator-media-retention','40 4 * * *',$$ SELECT ops.prune_operator_media() $$);
COMMENT ON TABLE ops.operator_messages IS 'Envios humanos auditáveis e idempotentes. Cópia da mídia removida após 7 dias e confirmação de anexo no histórico.';
COMMIT;
