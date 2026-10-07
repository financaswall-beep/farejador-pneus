// Leitura derivada: uma busca posterior pode resolver o bairro informado antes.
// Não herda buscas anteriores à localização vigente nem escolhe cidades ambíguas.
// $1 é sempre o ambiente da consulta; não altera fatos, pinos ou trilhas históricas.
export const botDemandLocationSql = `
  SELECT c.environment,c.id AS conversation_id,
    COALESCE(NULLIF(btrim(l.municipio),''),s.municipio) AS municipio,
    GREATEST(l.observed_at,s.observed_at) AS observed_at
  FROM core.conversations c
  LEFT JOIN analytics.v_bot_demand_location l
    ON l.environment=c.environment AND l.conversation_id=c.id
  LEFT JOIN LATERAL (
    SELECT max(a.at) AS observed_at FROM (
      SELECT COALESCE(f.observed_at,f.created_at) AS at
      FROM analytics.conversation_facts f
      WHERE f.environment=c.environment AND f.conversation_id=c.id
        AND f.fact_key='localizacao_lead' AND f.superseded_by IS NULL
        AND jsonb_typeof(f.fact_value)='object'
        AND (NULLIF(btrim(f.fact_value->>'bairro'),'') IS NOT NULL
          OR NULLIF(btrim(f.fact_value->>'municipio'),'') IS NOT NULL
          OR (NULLIF(btrim(f.fact_value->>'rua'),'') IS NULL
            AND NULLIF(btrim(f.fact_value->>'numero'),'') IS NULL))
      UNION ALL
      SELECT a.created_at FROM core.message_attachments a
      JOIN core.messages m ON m.environment=a.environment AND m.id=a.message_id
      WHERE a.environment=c.environment AND a.conversation_id=c.id
        AND a.file_type='location' AND a.coordinates_lat BETWEEN -90 AND 90
        AND a.coordinates_lng BETWEEN -180 AND 180
        AND m.deleted_at IS NULL AND m.message_type=0 AND NOT m.is_private
    ) a WHERE a.at<=l.observed_at
  ) anchor ON NULLIF(btrim(l.municipio),'') IS NULL
  LEFT JOIN LATERAL (
    SELECT min(btrim(b.municipality)) AS municipio,max(b.occurred_at) AS observed_at
    FROM ops.bot_stock_searches b
    WHERE b.environment=c.environment AND b.conversation_id=c.id
      AND NULLIF(btrim(b.municipality),'') IS NOT NULL
      AND (l.observed_at IS NULL OR b.occurred_at>=COALESCE(anchor.observed_at,l.observed_at))
    HAVING count(DISTINCT btrim(b.municipality))=1
  ) s ON NULLIF(btrim(l.municipio),'') IS NULL
  WHERE c.environment=$1 AND c.deleted_at IS NULL`;
