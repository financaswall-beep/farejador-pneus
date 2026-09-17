-- Uma rua informada depois do bairro complementa a mesma localização do lead.
-- Ela não deve apagar o município já resolvido pela busca de estoque. A herança
-- usa a última região (bairro/município) anterior e só ocorre quando o novo fato
-- traz apenas partes de endereço; assim, um bairro novo/desconhecido vira uma
-- nova âncora sem cidade e não recebe uma cidade antiga por acidente.

BEGIN;

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
), location_facts AS (
  SELECT f.*,
         NULLIF(btrim(f.fact_value->>'municipio'),'') AS explicit_municipio,
         NULLIF(btrim(f.fact_value->>'bairro'),'') AS explicit_bairro,
         NULLIF(btrim(f.fact_value->>'rua'),'') AS explicit_rua,
         NULLIF(btrim(f.fact_value->>'numero'),'') AS explicit_numero
    FROM analytics.conversation_facts f
   WHERE f.fact_key='localizacao_lead' AND f.superseded_by IS NULL
     AND jsonb_typeof(f.fact_value)='object'
), resolved_facts AS (
  SELECT f.*,
         COALESCE(f.explicit_municipio,same_message.municipio,
           CASE WHEN f.explicit_bairro IS NULL
                  AND (f.explicit_rua IS NOT NULL OR f.explicit_numero IS NOT NULL)
                THEN previous_region.municipio END) AS resolved_municipio,
         CASE WHEN same_message.municipio IS NOT NULL OR
                   (f.explicit_bairro IS NULL
                    AND (f.explicit_rua IS NOT NULL OR f.explicit_numero IS NOT NULL)
                    AND previous_region.municipio IS NOT NULL)
              THEN 'stock_search_municipality' ELSE f.source END AS resolved_source,
         CASE WHEN same_message.municipio IS NOT NULL OR
                   (f.explicit_bairro IS NULL
                    AND (f.explicit_rua IS NOT NULL OR f.explicit_numero IS NOT NULL)
                    AND previous_region.municipio IS NOT NULL)
              THEN 'inferred' ELSE 'observed' END AS resolved_truth_type,
         CASE WHEN same_message.municipio IS NOT NULL OR
                   (f.explicit_bairro IS NULL
                    AND (f.explicit_rua IS NOT NULL OR f.explicit_numero IS NOT NULL)
                    AND previous_region.municipio IS NOT NULL)
              THEN 0.90::numeric ELSE 1.00::numeric END AS resolved_confidence
    FROM location_facts f
    LEFT JOIN LATERAL (
      SELECT min(btrim(b.municipality)) AS municipio
        FROM ops.bot_stock_searches b
       WHERE b.environment=f.environment AND b.conversation_id=f.conversation_id
         AND b.trigger_message_id=f.message_id
         AND NULLIF(btrim(b.municipality),'') IS NOT NULL
         AND f.explicit_municipio IS NULL
      HAVING count(DISTINCT btrim(b.municipality))=1
    ) same_message ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(p.explicit_municipio,region_search.municipio) AS municipio
        FROM location_facts p
        LEFT JOIN LATERAL (
          SELECT min(btrim(b.municipality)) AS municipio
            FROM ops.bot_stock_searches b
           WHERE b.environment=p.environment AND b.conversation_id=p.conversation_id
             AND b.trigger_message_id=p.message_id
             AND NULLIF(btrim(b.municipality),'') IS NOT NULL
             AND p.explicit_municipio IS NULL
          HAVING count(DISTINCT btrim(b.municipality))=1
        ) region_search ON true
       WHERE p.environment=f.environment AND p.conversation_id=f.conversation_id
         AND COALESCE(p.observed_at,p.created_at) < COALESCE(f.observed_at,f.created_at)
         AND (p.explicit_municipio IS NOT NULL OR p.explicit_bairro IS NOT NULL)
       ORDER BY COALESCE(p.observed_at,p.created_at) DESC,p.id DESC
       LIMIT 1
    ) previous_region ON f.explicit_municipio IS NULL AND f.explicit_bairro IS NULL
      AND (f.explicit_rua IS NOT NULL OR f.explicit_numero IS NOT NULL)
), candidates AS (
  SELECT p.environment,p.conversation_id,p.id,p.observed_at,
         NULLIF(btrim(g.value->>'municipio'),'') AS municipio,
         'location_pin_geocode'::text AS source,1 AS priority,
         'observed'::text AS truth_type,1.00::numeric AS confidence_level
    FROM latest_pin p
    LEFT JOIN commerce.geo_cache g ON g.cache_key=p.cache_key AND g.kind='reverse'
  UNION ALL
  SELECT f.environment,f.conversation_id,f.id,COALESCE(f.observed_at,f.created_at),
         f.resolved_municipio,f.resolved_source,0,
         f.resolved_truth_type,f.resolved_confidence
    FROM resolved_facts f
  UNION ALL
  SELECT f.environment,f.conversation_id,f.id,COALESCE(f.observed_at,f.created_at),
         NULLIF(btrim(f.fact_value #>> '{}'),''),f.source,0,'observed',1.00
    FROM analytics.conversation_facts f
   WHERE f.fact_key='municipio_entrega' AND f.superseded_by IS NULL
     AND jsonb_typeof(f.fact_value)='string'
)
SELECT DISTINCT ON (r.environment,r.conversation_id)
       r.environment,r.conversation_id,r.municipio,r.observed_at,r.source,
       'sql_demand_location_v4_2026-09-17'::text AS extractor_version,
       r.truth_type,r.confidence_level
  FROM candidates r
  JOIN core.conversations c ON c.id=r.conversation_id AND c.environment=r.environment
 WHERE c.deleted_at IS NULL
 ORDER BY r.environment,r.conversation_id,r.observed_at DESC,r.priority DESC,r.id DESC;

REVOKE ALL ON analytics.v_bot_demand_location FROM PUBLIC,farejador_partner_app;
COMMENT ON VIEW analytics.v_bot_demand_location IS
'Município mais recente para demanda. Endereço parcial complementa a última região resolvida sem herdar cidade após bairro novo.';

COMMIT;
