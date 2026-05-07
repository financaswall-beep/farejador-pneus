-- ============================================================
-- 0028_generator_blocked_turn_audit.sql
-- PR 1: auditoria de turns bloqueados do Generator Shadow.
--
-- Aditiva/idempotente:
-- - persiste texto/actions candidatos quando o Generator e bloqueado;
-- - permite auditar falso positivo do Say Validator sem reprocessar LLM.
-- ============================================================

ALTER TABLE agent.turns
  ADD COLUMN IF NOT EXISTS blocked_say_text TEXT,
  ADD COLUMN IF NOT EXISTS blocked_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS blocked_payload JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'turns_blocked_actions_array_check'
      AND conrelid = 'agent.turns'::regclass
  ) THEN
    ALTER TABLE agent.turns
      ADD CONSTRAINT turns_blocked_actions_array_check
      CHECK (jsonb_typeof(blocked_actions) = 'array');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'turns_blocked_payload_object_check'
      AND conrelid = 'agent.turns'::regclass
  ) THEN
    ALTER TABLE agent.turns
      ADD CONSTRAINT turns_blocked_payload_object_check
      CHECK (blocked_payload IS NULL OR jsonb_typeof(blocked_payload) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS turns_blocked_audit_idx
  ON agent.turns (environment, error_message, created_at DESC)
  WHERE status = 'blocked';

COMMENT ON COLUMN agent.turns.blocked_say_text IS
  'Texto candidato que o Generator tentou produzir quando o turno foi bloqueado. NULL quando status <> blocked ou quando nao houve candidato.';

COMMENT ON COLUMN agent.turns.blocked_actions IS
  'Actions hidratadas candidatas quando o turno foi bloqueado. Array vazio quando nao houve candidato.';

COMMENT ON COLUMN agent.turns.blocked_payload IS
  'Snapshot auditavel do bloqueio: motivo, candidato, raw_actions quando disponiveis e metadados do Generator.';
