-- ============================================================
-- 0160_bot_analytics_outbox_repair.sql
-- Restaura o gerador deterministico de analytics no fluxo BOT_OUTBOX.
--
-- Antes desta migration, o trigger rodava somente no INSERT de agent.turns.
-- O outbox insere o turno como generated e depois muda o status para
-- delivered, portanto a extracao nunca era executada.
--
-- O trigger novo processa a primeira entrada em delivered e ignora updates
-- posteriores que mantenham o mesmo estado, para nao duplicar.
-- O backfill recupera apenas artefatos SQL ausentes e preserva os existentes.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION analytics._trigger_extract_facts()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.agent_version <> 'v2'
     OR NEW.status <> 'delivered' THEN
    RETURN NEW;
  END IF;

  -- O mesmo turno pode receber updates posteriores. A primeira transicao para
  -- delivered deve ser processada uma unica vez.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'delivered' THEN
    RETURN NEW;
  END IF;

  PERFORM analytics.extract_facts_from_turn(NEW.id);
  PERFORM analytics.extract_linguistic_hints_for_conv(NEW.conversation_id);
  PERFORM analytics.extract_classifications_for_conv(NEW.conversation_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trigger analytics %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS analytics_extract_facts ON agent.turns;
CREATE TRIGGER analytics_extract_facts
AFTER INSERT OR UPDATE OF status ON agent.turns
FOR EACH ROW
EXECUTE FUNCTION analytics._trigger_extract_facts();

-- Turnos que passaram pelo outbox enquanto o trigger escutava apenas INSERT.
-- A funcao de facts e chamada somente quando nao existe nenhum fato SQL ligado
-- a mensagem gatilho; assim registros analiticos anteriores nao sao reescritos.
DO $backfill$
DECLARE
  v_turn record;
  v_conversation record;
BEGIN
  FOR v_turn IN
    SELECT t.id
    FROM agent.turns t
    WHERE t.agent_version = 'v2'
      AND t.status = 'delivered'
      AND NOT EXISTS (
        SELECT 1
        FROM analytics.conversation_facts f
        WHERE f.environment = t.environment
          AND f.conversation_id = t.conversation_id
          AND f.message_id = t.trigger_message_id
          AND f.extractor_version = 'sql_v1_2026-05-26'
      )
    ORDER BY t.created_at, t.id
  LOOP
    PERFORM analytics.extract_facts_from_turn(v_turn.id);
  END LOOP;

  FOR v_conversation IN
    SELECT t.environment, t.conversation_id, min(t.created_at) AS first_turn_at
    FROM agent.turns t
    WHERE t.agent_version = 'v2'
      AND t.status = 'delivered'
    GROUP BY t.environment, t.conversation_id
    ORDER BY first_turn_at, t.conversation_id
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM analytics.linguistic_hints h
      WHERE h.environment = v_conversation.environment
        AND h.conversation_id = v_conversation.conversation_id
        AND h.extractor_version = 'sql_v1_2026-05-26'
    ) THEN
      PERFORM analytics.extract_linguistic_hints_for_conv(v_conversation.conversation_id);
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM analytics.conversation_classifications c
      WHERE c.environment = v_conversation.environment
        AND c.conversation_id = v_conversation.conversation_id
        AND c.dimension = 'stage_reached'
        AND c.extractor_version = 'sql_v1_2026-05-26'
    ) THEN
      PERFORM analytics.extract_classifications_for_conv(v_conversation.conversation_id);
    END IF;
  END LOOP;
END;
$backfill$;

COMMIT;
