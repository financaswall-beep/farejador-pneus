-- Isola cada extrator analítico do gatilho do Bot V2.
-- Uma falha em classificação ou hints não pode desfazer um fato já extraído,
-- especialmente a localização digitada pelo lead.

BEGIN;

CREATE OR REPLACE FUNCTION analytics._trigger_extract_facts()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.agent_version <> 'v2' OR NEW.status <> 'delivered' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'delivered' THEN RETURN NEW; END IF;

  BEGIN
    PERFORM analytics.extract_facts_from_turn(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trigger analytics facts %: %', NEW.id, SQLERRM;
  END;

  BEGIN
    PERFORM analytics.extract_product_quote_facts(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trigger analytics quote %: %', NEW.id, SQLERRM;
  END;

  BEGIN
    PERFORM analytics.extract_lead_location_facts(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trigger analytics lead location %: %', NEW.id, SQLERRM;
  END;

  BEGIN
    PERFORM analytics.extract_linguistic_hints_for_conv(NEW.conversation_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trigger analytics hints %: %', NEW.id, SQLERRM;
  END;

  BEGIN
    PERFORM analytics.extract_classifications_for_conv(NEW.conversation_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trigger analytics classifications %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

DO $check$
BEGIN
  IF to_regprocedure('analytics._trigger_extract_facts()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid='agent.turns'::regclass
          AND tgname='analytics_extract_facts'
          AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION '0221 falhou: gatilho analítico isolado ausente';
  END IF;
END;
$check$;

COMMIT;
