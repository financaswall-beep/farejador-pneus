// All sources are bounded by environment and business dates before aggregation.
export const demandEventsSql=`WITH bounds AS (
  SELECT $2::date::timestamp AT TIME ZONE 'America/Sao_Paulo' AS lo,
    ($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo' AS hi
), events AS (
  SELECT t.conversation_id,t.created_at AS at,'activity'::text AS kind,NULL::text AS measure
  FROM agent.turns t,bounds b WHERE t.environment=$1 AND t.agent_version='v2'
    AND t.status IN ('sent_api_ack','delivered') AND t.created_at>=b.lo AND t.created_at<b.hi
  UNION ALL
  SELECT f.conversation_id,COALESCE(f.observed_at,f.created_at),
    CASE WHEN f.fact_key='medida_consultada' THEN 'measure' ELSE 'shortage' END,
    CASE WHEN f.fact_key='medida_consultada' AND jsonb_typeof(f.fact_value)='string'
      THEN NULLIF(btrim(f.fact_value#>>'{}'),'') ELSE NULL END
  FROM analytics.conversation_facts f,bounds b WHERE f.environment=$1 AND f.superseded_by IS NULL
    AND f.fact_key IN ('medida_consultada','faltou_estoque')
    AND COALESCE(f.observed_at,f.created_at)>=b.lo AND COALESCE(f.observed_at,f.created_at)<b.hi
  UNION ALL
  SELECT s.conversation_id,s.occurred_at,k.kind,CASE WHEN k.kind='measure' THEN s.measure END
  FROM ops.bot_stock_searches s,bounds b,
    LATERAL(SELECT 'measure'::text AS kind UNION ALL SELECT 'shortage'
      WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(s.stores) st WHERE st->>'available'='false')) k
  WHERE s.environment=$1 AND s.occurred_at>=b.lo AND s.occurred_at<b.hi
  UNION ALL
  SELECT o.source_conversation_id,o.created_at,'order',NULL
  FROM commerce.orders o LEFT JOIN commerce.partner_orders po ON po.id=o.partner_order_id AND po.environment=o.environment,bounds b
  WHERE o.environment=$1 AND o.source_conversation_id IS NOT NULL AND o.status<>'cancelled'
    AND (o.partner_order_id IS NULL OR (po.id IS NOT NULL AND po.status<>'cancelled' AND po.deleted_at IS NULL))
    AND o.created_at>=b.lo AND o.created_at<b.hi
  UNION ALL
  SELECT o.source_conversation_id,CASE WHEN o.partner_order_id IS NULL THEN o.delivered_at ELSE po.delivered_at END,'delivery',NULL
  FROM commerce.orders o LEFT JOIN commerce.partner_orders po ON po.id=o.partner_order_id AND po.environment=o.environment,bounds b
  WHERE o.environment=$1 AND o.source_conversation_id IS NOT NULL AND o.status<>'cancelled'
    AND ((o.partner_order_id IS NULL AND o.fulfillment_mode='delivery' AND o.delivery_status='delivered')
      OR (po.fulfillment_mode='delivery' AND po.delivery_status='delivered' AND po.status<>'cancelled' AND po.deleted_at IS NULL))
    AND (CASE WHEN o.partner_order_id IS NULL THEN o.delivered_at ELSE po.delivered_at END)>=b.lo
    AND (CASE WHEN o.partner_order_id IS NULL THEN o.delivered_at ELSE po.delivered_at END)<b.hi
), grouped AS (
  SELECT e.conversation_id,e.kind,e.measure,to_char(min(e.at) AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS day
  FROM events e JOIN core.conversations c ON c.id=e.conversation_id AND c.environment=$1 AND c.deleted_at IS NULL
  WHERE e.kind<>'measure' OR e.measure IS NOT NULL
  GROUP BY e.conversation_id,e.kind,e.measure
)
SELECT g.*,COALESCE(NULLIF(btrim(l.municipio),''),fallback.municipality) AS municipality
FROM grouped g LEFT JOIN analytics.v_bot_demand_location l ON l.environment=$1 AND l.conversation_id=g.conversation_id
LEFT JOIN LATERAL(SELECT NULLIF(btrim(s.municipality),'') AS municipality FROM ops.bot_stock_searches s
  WHERE s.environment=$1 AND s.conversation_id=g.conversation_id AND NULLIF(btrim(s.municipality),'') IS NOT NULL
  ORDER BY s.occurred_at DESC,s.id DESC LIMIT 1) fallback ON NULLIF(btrim(l.municipio),'') IS NULL
ORDER BY g.conversation_id,g.kind,g.measure LIMIT 50001`;
