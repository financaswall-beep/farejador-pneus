-- Memória curta é code-only. Esta migration amplia a outbox durável para a
-- única mutação nova: definir uma conversa do Chatwoot como resolvida.
-- A ação não envia texto ao cliente e é idempotente no provedor.

BEGIN;

ALTER TABLE ops.outbound_messages
  DROP CONSTRAINT IF EXISTS outbound_messages_kind_check;

ALTER TABLE ops.outbound_messages
  ADD CONSTRAINT outbound_messages_kind_check
  CHECK (kind IN (
    'agent_text','survey_text','photo_text','photo_attachment','conversation_resolution'
  ));

COMMENT ON COLUMN ops.outbound_messages.kind IS
  'Tipo da ação externa. conversation_resolution define status resolved no Chatwoot sem mensagem pública.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='ops.outbound_messages'::regclass
       AND conname='outbound_messages_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%conversation_resolution%'
  ) THEN
    RAISE EXCEPTION '0219 falhou: conversation_resolution ausente da outbox';
  END IF;
END;
$check$;

COMMIT;
