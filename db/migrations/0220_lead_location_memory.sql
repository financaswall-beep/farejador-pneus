-- Localização digitada pelo lead, separada do endereço confirmado do pedido.
-- O LLM apenas estrutura o texto em uma tool versionada; a persistência é SQL,
-- append-only, depois que a resposta foi efetivamente entregue ao cliente.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS facts_lead_location_exact_dedup_idx
  ON analytics.conversation_facts
    (environment, conversation_id, message_id, fact_key, (md5(fact_value::text)))
  WHERE extractor_version = 'llm_tool_lead_location_v1_2026-09-08';

CREATE OR REPLACE FUNCTION analytics.extract_lead_location_facts(p_turn_id uuid)
RETURNS integer LANGUAGE plpgsql AS $function$
DECLARE
  v_turn record;
  v_action jsonb;
  v_call jsonb;
  v_args jsonb;
  v_value jsonb;
  v_text text;
  v_type text;
  v_inserted integer := 0;
  v_count integer := 0;
BEGIN
  SELECT * INTO v_turn
    FROM agent.turns
   WHERE id=p_turn_id AND agent_version='v2' AND status='delivered'
   FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(v_turn.actions) IS DISTINCT FROM 'array' THEN RETURN 0; END IF;

  FOR v_action IN SELECT * FROM jsonb_array_elements(v_turn.actions) LOOP
    IF v_action->>'role' IS DISTINCT FROM 'assistant'
       OR jsonb_typeof(v_action->'tool_calls') IS DISTINCT FROM 'array' THEN CONTINUE; END IF;
    FOR v_call IN SELECT * FROM jsonb_array_elements(v_action->'tool_calls') LOOP
      IF v_call->'function'->>'name' IS DISTINCT FROM 'registrar_localizacao_lead' THEN CONTINUE; END IF;
      v_args := NULL;
      BEGIN
        v_args := (v_call->'function'->>'arguments')::jsonb;
      EXCEPTION WHEN invalid_text_representation THEN CONTINUE;
      END;
      IF jsonb_typeof(v_args) IS DISTINCT FROM 'object' THEN CONTINUE; END IF;

      v_text := left(btrim(COALESCE(v_args->>'texto_informado','')),300);
      v_type := v_args->>'tipo';
      IF v_text='' OR v_type IS NULL
         OR v_type NOT IN ('regiao_digitada','endereco_digitado') THEN CONTINUE; END IF;
      v_value := jsonb_strip_nulls(jsonb_build_object(
        'texto_informado',v_text,
        'tipo',v_type,
        'rua',NULLIF(left(btrim(COALESCE(v_args->>'rua','')),160),''),
        'numero',NULLIF(left(btrim(COALESCE(v_args->>'numero','')),30),''),
        'bairro',NULLIF(left(btrim(COALESCE(v_args->>'bairro','')),100),''),
        'municipio',NULLIF(left(btrim(COALESCE(v_args->>'municipio','')),100),'')
      ));

      WITH inserted AS (
        INSERT INTO analytics.conversation_facts
          (environment,conversation_id,message_id,observed_at,fact_key,fact_value,
           truth_type,source,confidence_level,extractor_version,ruleset_hash)
        VALUES
          (v_turn.environment,v_turn.conversation_id,v_turn.trigger_message_id,v_turn.created_at,
           'localizacao_lead',v_value,'inferred','llm_tool_call_v2',0.90,
           'llm_tool_lead_location_v1_2026-09-08','llm_tool_lead_location_v1_2026-09-08')
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      INSERT INTO analytics.fact_evidence
        (environment,fact_id,from_message_id,evidence_text,evidence_type,extractor_version)
      SELECT v_turn.environment,id,v_turn.trigger_message_id,v_text,'inferred',
             'llm_tool_lead_location_v1_2026-09-08'
        FROM inserted;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      v_count := v_count + v_inserted;
    END LOOP;
  END LOOP;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION analytics._trigger_extract_facts()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.agent_version <> 'v2' OR NEW.status <> 'delivered' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'delivered' THEN RETURN NEW; END IF;
  PERFORM analytics.extract_facts_from_turn(NEW.id);
  PERFORM analytics.extract_product_quote_facts(NEW.id);
  PERFORM analytics.extract_lead_location_facts(NEW.id);
  PERFORM analytics.extract_linguistic_hints_for_conv(NEW.conversation_id);
  PERFORM analytics.extract_classifications_for_conv(NEW.conversation_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trigger analytics %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE VIEW analytics.v_bot_demand_location
WITH (security_invoker = true) AS
WITH latest_pin AS (
  SELECT DISTINCT ON (a.environment,a.conversation_id)
         a.environment,a.conversation_id,a.id,a.created_at AS observed_at,
         'r:' || to_char(round(a.coordinates_lat::numeric,4),'FM990.0000') || ',' ||
                  to_char(round(a.coordinates_lng::numeric,4),'FM990.0000') AS cache_key
    FROM core.message_attachments a
    JOIN core.messages m ON m.id=a.message_id AND m.environment=a.environment
   WHERE a.file_type='location' AND a.coordinates_lat BETWEEN -90 AND 90
     AND a.coordinates_lng BETWEEN -180 AND 180
     AND m.deleted_at IS NULL AND m.message_type=0 AND NOT m.is_private
   ORDER BY a.environment,a.conversation_id,a.created_at DESC,a.id DESC
), candidates AS (
  SELECT p.environment,p.conversation_id,p.id,p.observed_at,
         NULLIF(btrim(g.value->>'municipio'),'') AS municipio,
         'location_pin_geocode'::text AS source,1 AS priority
    FROM latest_pin p
    LEFT JOIN commerce.geo_cache g ON g.cache_key=p.cache_key AND g.kind='reverse'
  UNION ALL
  SELECT f.environment,f.conversation_id,f.id,COALESCE(f.observed_at,f.created_at),
         NULLIF(btrim(f.fact_value->>'municipio'),''),f.source,0
    FROM analytics.conversation_facts f
   WHERE f.fact_key='localizacao_lead' AND f.superseded_by IS NULL
     AND jsonb_typeof(f.fact_value)='object'
  UNION ALL
  SELECT f.environment,f.conversation_id,f.id,COALESCE(f.observed_at,f.created_at),
         NULLIF(btrim(f.fact_value #>> '{}'),''),f.source,0
    FROM analytics.conversation_facts f
   WHERE f.fact_key='municipio_entrega' AND f.superseded_by IS NULL
     AND jsonb_typeof(f.fact_value)='string'
)
SELECT DISTINCT ON (r.environment,r.conversation_id)
       r.environment,r.conversation_id,r.municipio,r.observed_at,r.source,
       'sql_demand_location_v2_2026-09-08'::text AS extractor_version,
       'observed'::text AS truth_type,1.00::numeric AS confidence_level
  FROM candidates r
  JOIN core.conversations c ON c.id=r.conversation_id AND c.environment=r.environment
 WHERE c.deleted_at IS NULL
 ORDER BY r.environment,r.conversation_id,r.observed_at DESC,r.priority DESC,r.id DESC;

REVOKE ALL ON analytics.v_bot_demand_location FROM PUBLIC,farejador_partner_app;
REVOKE ALL ON FUNCTION analytics.extract_lead_location_facts(uuid) FROM PUBLIC,farejador_partner_app;

DO $check$
BEGIN
  IF to_regprocedure('analytics.extract_lead_location_facts(uuid)') IS NULL
     OR to_regclass('analytics.v_bot_demand_location') IS NULL THEN
    RAISE EXCEPTION '0220 falhou: memória de localização do lead ausente';
  END IF;
END;
$check$;

COMMIT;
