-- Preço por medida também é cotação; pino também é demanda, mesmo na retirada.
-- Extração determinística, sem LLM/API externa e sem escrever em raw/core.
-- Facts novos são append-only e idempotentes. Não reexecuta ferramentas/pedidos.

CREATE UNIQUE INDEX IF NOT EXISTS facts_product_quote_exact_dedup_idx
  ON analytics.conversation_facts
    (environment, conversation_id, message_id, fact_key, (md5(fact_value::text)))
  WHERE extractor_version = 'sql_product_quote_v1_2026-09-06';

CREATE OR REPLACE FUNCTION analytics.extract_product_quote_facts(p_turn_id uuid)
RETURNS integer LANGUAGE plpgsql AS $function$
DECLARE
  v_turn record;
  v_action jsonb;
  v_call jsonb;
  v_result jsonb;
  v_product jsonb;
  v_count integer := 0;
  v_inserted integer;
BEGIN
  -- Serializa replay do mesmo turno. O envio precisa estar confirmado.
  SELECT * INTO v_turn FROM agent.turns
  WHERE id = p_turn_id AND agent_version = 'v2' AND status = 'delivered'
  FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(v_turn.actions) IS DISTINCT FROM 'array' THEN RETURN 0; END IF;

  FOR v_action IN SELECT * FROM jsonb_array_elements(v_turn.actions) LOOP
    IF v_action->>'role' IS DISTINCT FROM 'assistant'
       OR jsonb_typeof(v_action->'tool_calls') IS DISTINCT FROM 'array' THEN CONTINUE; END IF;
    FOR v_call IN SELECT * FROM jsonb_array_elements(v_action->'tool_calls') LOOP
      IF v_call->'function'->>'name' IS DISTINCT FROM 'buscar_produto' THEN CONTINUE; END IF;
      v_result := NULL;
      BEGIN
        SELECT CASE WHEN jsonb_typeof(a->'content') = 'string'
                    THEN (a->>'content')::jsonb ELSE a->'content' END
        INTO v_result
        FROM jsonb_array_elements(v_turn.actions) a
        WHERE a->>'role' = 'tool' AND a->>'tool_call_id' = v_call->>'id'
        LIMIT 1;
      EXCEPTION WHEN invalid_text_representation THEN CONTINUE;
      END;
      IF v_result->>'encontrado' IS DISTINCT FROM 'true' OR v_result ? 'erro'
         OR jsonb_typeof(v_result->'produtos') IS DISTINCT FROM 'array' THEN CONTINUE; END IF;

      FOR v_product IN SELECT * FROM jsonb_array_elements(v_result->'produtos') LOOP
        -- Sem preço válido não afirmamos que o cliente recebeu cotação.
        IF COALESCE(v_product->>'price_amount', '') !~ '^[0-9]+([.][0-9]+)?$'
           THEN CONTINUE; END IF;
        WITH inserted AS (
          INSERT INTO analytics.conversation_facts
            (environment, conversation_id, message_id, observed_at, fact_key, fact_value,
             truth_type, source, confidence_level, extractor_version, ruleset_hash)
          SELECT v_turn.environment, v_turn.conversation_id, v_turn.trigger_message_id,
                 v_turn.created_at, f.key, f.value, 'observed', 'tool_result_v2', 1.00,
                 'sql_product_quote_v1_2026-09-06', 'sql_product_quote_v1_2026-09-06'
          FROM (VALUES
            ('produto_cotado', v_product->'product_name'),
            ('preco_cotado', v_product->'price_amount'),
            ('medida_pneu', v_product->'tire_size')
          ) AS f(key, value)
          WHERE f.value IS NOT NULL AND f.value NOT IN ('null'::jsonb, '""'::jsonb)
          ON CONFLICT DO NOTHING RETURNING id, fact_key
        )
        INSERT INTO analytics.fact_evidence
          (environment, fact_id, from_message_id, evidence_text, evidence_type, extractor_version)
        SELECT v_turn.environment, id, v_turn.trigger_message_id,
               'tool_result:buscar_produto:' || fact_key, 'inferred', 'sql_product_quote_v1_2026-09-06'
        FROM inserted;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        v_count := v_count + v_inserted;
      END LOOP;
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
  PERFORM analytics.extract_linguistic_hints_for_conv(NEW.conversation_id);
  PERFORM analytics.extract_classifications_for_conv(NEW.conversation_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trigger analytics %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

-- A localização não depende de fechar pedido nem de calcular frete. Reaproveita
-- SOMENTE a geocodificação já feita para aquele pino; não adivinha município.
-- Nunca expõe coordenadas/endereço ao painel. O pino mais novo ainda sem resolução
-- bloqueia o município antigo, evitando marcar o cliente na cidade errada.
CREATE OR REPLACE VIEW analytics.v_bot_demand_location
WITH (security_invoker = true) AS
WITH latest_pin AS (
  SELECT DISTINCT ON (a.environment, a.conversation_id)
         a.environment, a.conversation_id, a.id, a.created_at AS observed_at,
         'r:' || to_char(round(a.coordinates_lat::numeric, 4), 'FM990.0000') || ',' ||
                  to_char(round(a.coordinates_lng::numeric, 4), 'FM990.0000') AS cache_key
  FROM core.message_attachments a
  JOIN core.messages m ON m.id = a.message_id AND m.environment = a.environment
  WHERE a.file_type = 'location' AND a.coordinates_lat BETWEEN -90 AND 90
    AND a.coordinates_lng BETWEEN -180 AND 180
    AND m.deleted_at IS NULL AND m.message_type = 0 AND NOT m.is_private
  ORDER BY a.environment, a.conversation_id, a.created_at DESC, a.id DESC
), candidates AS (
  SELECT p.environment, p.conversation_id, p.id, p.observed_at,
         NULLIF(btrim(g.value->>'municipio'), '') AS municipio,
         'location_pin_geocode'::text AS source, 1 AS priority
  FROM latest_pin p
  LEFT JOIN commerce.geo_cache g ON g.cache_key = p.cache_key AND g.kind = 'reverse'
  UNION ALL
  SELECT f.environment, f.conversation_id, f.id, COALESCE(f.observed_at, f.created_at),
         NULLIF(btrim(f.fact_value #>> '{}'), ''), f.source, 0
  FROM analytics.conversation_facts f
  WHERE f.fact_key = 'municipio_entrega' AND f.superseded_by IS NULL
    AND jsonb_typeof(f.fact_value) = 'string'
)
SELECT DISTINCT ON (r.environment, r.conversation_id)
       r.environment, r.conversation_id, r.municipio, r.observed_at, r.source,
       'sql_demand_location_v1_2026-09-06'::text AS extractor_version,
       'observed'::text AS truth_type, 1.00::numeric AS confidence_level
FROM candidates r
JOIN core.conversations c ON c.id = r.conversation_id AND c.environment = r.environment
WHERE c.deleted_at IS NULL
ORDER BY r.environment, r.conversation_id, r.observed_at DESC, r.priority DESC, r.id DESC;

REVOKE ALL ON analytics.v_bot_demand_location FROM PUBLIC, farejador_partner_app;
REVOKE ALL ON FUNCTION analytics.extract_product_quote_facts(uuid) FROM PUBLIC, farejador_partner_app;

-- Recupera cotações já enviadas na janela máxima do painel. Preserva facts antigos
-- e só recalcula as classificações SQL determinísticas pelo mecanismo existente.
DO $backfill$
DECLARE v_turn record;
BEGIN
  FOR v_turn IN
    SELECT id, conversation_id FROM agent.turns
    WHERE agent_version = 'v2' AND status = 'delivered'
      AND created_at >= now() - interval '30 days'
    ORDER BY created_at, id
  LOOP
    IF analytics.extract_product_quote_facts(v_turn.id) > 0 THEN
      PERFORM analytics.extract_classifications_for_conv(v_turn.conversation_id);
    END IF;
  END LOOP;
END;
$backfill$;
