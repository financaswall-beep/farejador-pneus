-- Reaproveita o município resolvido na busca da mesma mensagem do lead.
-- A consulta pode preceder a gravação do fact; não depende da ordem de gravação.
-- Não altera fatos históricos nem transforma bairro em endereço de entrega.
CREATE INDEX IF NOT EXISTS bot_stock_searches_location_message
  ON ops.bot_stock_searches(environment, conversation_id, trigger_message_id)
  WHERE NULLIF(btrim(municipality),'') IS NOT NULL;

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
         'location_pin_geocode'::text AS source,1 AS priority,
         'observed'::text AS truth_type,1.00::numeric AS confidence_level
    FROM latest_pin p
    LEFT JOIN commerce.geo_cache g ON g.cache_key=p.cache_key AND g.kind='reverse'
  UNION ALL
  SELECT f.environment,f.conversation_id,f.id,COALESCE(f.observed_at,f.created_at),
         COALESCE(NULLIF(btrim(f.fact_value->>'municipio'),''),s.municipio),
         CASE WHEN s.municipio IS NOT NULL THEN 'stock_search_municipality' ELSE f.source END,
         0,
         CASE WHEN s.municipio IS NOT NULL THEN 'inferred' ELSE 'observed' END,
         CASE WHEN s.municipio IS NOT NULL THEN 0.90 ELSE 1.00 END
    FROM analytics.conversation_facts f
    LEFT JOIN LATERAL (
      SELECT min(btrim(b.municipality)) AS municipio
        FROM ops.bot_stock_searches b
       WHERE b.environment=f.environment AND b.conversation_id=f.conversation_id
         AND b.trigger_message_id=f.message_id
         AND NULLIF(btrim(b.municipality),'') IS NOT NULL
         AND NULLIF(btrim(f.fact_value->>'municipio'),'') IS NULL
      -- Mais de uma cidade na mesma mensagem não é evidência inequívoca.
      HAVING count(DISTINCT btrim(b.municipality))=1
    ) s ON true
   WHERE f.fact_key='localizacao_lead' AND f.superseded_by IS NULL
     AND jsonb_typeof(f.fact_value)='object'
  UNION ALL
  SELECT f.environment,f.conversation_id,f.id,COALESCE(f.observed_at,f.created_at),
         NULLIF(btrim(f.fact_value #>> '{}'),''),f.source,0,'observed',1.00
    FROM analytics.conversation_facts f
   WHERE f.fact_key='municipio_entrega' AND f.superseded_by IS NULL
     AND jsonb_typeof(f.fact_value)='string'
)
SELECT DISTINCT ON (r.environment,r.conversation_id)
       r.environment,r.conversation_id,r.municipio,r.observed_at,r.source,
       'sql_demand_location_v3_2026-09-11'::text AS extractor_version,
       r.truth_type,r.confidence_level
  FROM candidates r
  JOIN core.conversations c ON c.id=r.conversation_id AND c.environment=r.environment
 WHERE c.deleted_at IS NULL
 ORDER BY r.environment,r.conversation_id,r.observed_at DESC,r.priority DESC,r.id DESC;

REVOKE ALL ON analytics.v_bot_demand_location FROM PUBLIC,farejador_partner_app;
COMMENT ON VIEW analytics.v_bot_demand_location IS
'Município mais recente para análise de demanda. Complementa localização digitada com a busca da mesma mensagem, sem confirmar endereço de entrega.';
