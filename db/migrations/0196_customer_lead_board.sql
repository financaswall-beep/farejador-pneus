-- 0196 - Quadro operacional de leads da Matriz.
-- O quadro guarda apenas a decisao humana. Conversa, contato, venda e raw_events
-- continuam sendo as fontes historicas e nunca sao apagados ao "limpar" um card.

CREATE TABLE IF NOT EXISTS ops.customer_lead_board_state (
  environment    env_t NOT NULL,
  conversation_id UUID NOT NULL REFERENCES core.conversations(id) ON DELETE RESTRICT,
  manual_lane    TEXT CHECK (manual_lane IN ('novo','atendimento','orcamento','perdido')),
  archived_at    TIMESTAMPTZ,
  archived_by    TEXT,
  archive_reason TEXT,
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment,conversation_id),
  CHECK (
    (archived_at IS NULL AND archived_by IS NULL AND archive_reason IS NULL)
    OR
    (archived_at IS NOT NULL AND NULLIF(btrim(archived_by),'') IS NOT NULL
      AND NULLIF(btrim(archive_reason),'') IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS customer_lead_board_archived_idx
  ON ops.customer_lead_board_state(environment,archived_at,updated_at DESC);

CREATE OR REPLACE FUNCTION ops.guard_customer_lead_board_environment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.conversations conversation
     WHERE conversation.id=NEW.conversation_id
       AND conversation.environment=NEW.environment
       AND conversation.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'customer_lead_conversation_not_found'
      USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION ops.guard_customer_lead_board_environment() FROM PUBLIC;

DROP TRIGGER IF EXISTS customer_lead_board_environment
  ON ops.customer_lead_board_state;
CREATE TRIGGER customer_lead_board_environment
BEFORE INSERT OR UPDATE OF environment,conversation_id
ON ops.customer_lead_board_state
FOR EACH ROW EXECUTE FUNCTION ops.guard_customer_lead_board_environment();

DROP TRIGGER IF EXISTS customer_lead_board_environment_immutable
  ON ops.customer_lead_board_state;
CREATE TRIGGER customer_lead_board_environment_immutable
BEFORE UPDATE OF environment
ON ops.customer_lead_board_state
FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

REVOKE ALL ON ops.customer_lead_board_state FROM PUBLIC;

COMMENT ON TABLE ops.customer_lead_board_state IS
  'Estado operacional manual do Kanban. Arquivar remove o card da fila ativa sem apagar contato, conversa, mensagens, venda ou auditoria.';
COMMENT ON COLUMN ops.customer_lead_board_state.manual_lane IS
  'Sobrescrita humana. Convertido nao pode ser manual: depende de venda confirmada.';
