-- Indicadores comerciais contam vendas realizadas e sua data, sem reservas,
-- cancelamentos, vendas manuais ou conversas identificadas pelo simulador.
BEGIN;
CREATE OR REPLACE VIEW analytics.v_bot_realized_orders
WITH (security_invoker=true) AS
SELECT o.environment,o.id,o.source_conversation_id,
  COALESCE(po.total_amount,o.total_amount)::numeric total_amount,
  CASE WHEN o.partner_order_id IS NOT NULL THEN
    CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
      ELSE COALESCE(po.retrieved_at,po.created_at) END
  ELSE CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at
    ELSE COALESCE(o.retrieved_at,o.created_at) END END realized_at
FROM commerce.orders o
JOIN core.conversations c ON c.environment=o.environment AND c.id=o.source_conversation_id
LEFT JOIN commerce.partner_orders po ON po.environment=o.environment AND po.id=o.partner_order_id
WHERE o.source IN ('bot_promoted','chatwoot_com_bot') AND o.status<>'cancelled'
  AND c.deleted_at IS NULL
  AND COALESCE(c.additional_attributes->>'farejador_simulator','false')<>'true'
  AND (
    (o.partner_order_id IS NULL AND o.status IN ('confirmed','paid','delivered')
      AND (o.fulfillment_mode<>'delivery' OR o.delivery_status='delivered'))
    OR (po.id IS NOT NULL AND po.deleted_at IS NULL
      AND po.status IN ('confirmed','paid','delivered') AND NOT po.awaiting_pickup
      AND (po.fulfillment_mode<>'delivery' OR po.delivery_status='delivered'))
  );
REVOKE ALL ON analytics.v_bot_realized_orders FROM PUBLIC,farejador_partner_app;

-- Mantém a base de conversas e custo do Bot. A dimensão comercial passa a usar
-- realização: uma conversa de ontem pode gerar venda hoje, e dois pedidos
-- realizados na mesma conversa continuam sendo duas vendas para o ticket.

CREATE OR REPLACE VIEW analytics.v_daily_metrics
WITH (security_invoker = true)
AS
WITH conversation_metrics AS (
  SELECT
    c.environment AS environment,
    c.id AS conversation_id,
    c.started_at,
    COALESCE(messages.total_messages, 0)::int AS total_messages,
    messages.first_response_seconds,
    COALESCE(turns.tokens_total, 0)::bigint AS tokens_total,
    round(COALESCE(turns.tokens_total, 0)::numeric / 1000000 * 5.50, 4)
      AS custo_estimado_brl,
    COALESCE(orders.pedido_total, 0)::numeric AS pedido_total,
    CASE
      WHEN orders.has_order THEN 'fechou'
      WHEN outcome.value = 'escalou' THEN 'escalou'
      WHEN EXISTS (
        SELECT 1
        FROM analytics.conversation_facts f
        WHERE f.environment = c.environment
          AND f.conversation_id = c.id
          AND f.fact_key = 'escalou'
          AND f.superseded_by IS NULL
      ) THEN 'escalou'
      WHEN EXISTS (
        SELECT 1
        FROM agent.turns t
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.actions, '[]'::jsonb)) action
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(action.value->'tool_calls', '[]'::jsonb)
        ) tool_call
        WHERE t.environment = c.environment
          AND t.conversation_id = c.id
          AND tool_call.value->'function'->>'name' = 'escalar_humano'
      ) THEN 'escalou'
      WHEN outcome.value IN ('desistiu_cedo', 'abandonou') THEN outcome.value
      WHEN COALESCE(messages.total_messages, 0) < 4 THEN 'desistiu_cedo'
      ELSE 'abandonou'
    END AS resultado,
    CASE
      WHEN extract(hour FROM c.started_at AT TIME ZONE 'America/Sao_Paulo') BETWEEN 0 AND 5
        THEN 'madrugada'
      WHEN extract(hour FROM c.started_at AT TIME ZONE 'America/Sao_Paulo') BETWEEN 6 AND 11
        THEN 'manha'
      WHEN extract(hour FROM c.started_at AT TIME ZONE 'America/Sao_Paulo') BETWEEN 12 AND 17
        THEN 'tarde'
      ELSE 'noite'
    END AS periodo_dia
  FROM core.conversations c
  LEFT JOIN LATERAL (
    SELECT
      count(m.*)::int AS total_messages,
      extract(epoch FROM (
        min(m.sent_at) FILTER (WHERE m.sender_type IN ('user', 'agent_bot'))
        - min(m.sent_at) FILTER (WHERE m.sender_type = 'contact')
      ))::int AS first_response_seconds
    FROM core.messages m
    WHERE m.environment = c.environment
      AND m.conversation_id = c.id
      AND m.deleted_at IS NULL
      AND m.is_private = false
  ) messages ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(
      COALESCE(t.llm_input_tokens, 0) + COALESCE(t.llm_output_tokens, 0)
    ), 0)::bigint AS tokens_total
    FROM agent.turns t
    WHERE t.environment = c.environment
      AND t.conversation_id = c.id
      AND t.agent_version = 'v2'
  ) turns ON true
  LEFT JOIN LATERAL (
    SELECT
      (count(*) > 0) AS has_order,
      COALESCE(sum(o.total_amount), 0)::numeric AS pedido_total
    FROM analytics.v_bot_realized_orders o
    WHERE o.environment = c.environment
      AND o.source_conversation_id = c.id
  ) orders ON true
  LEFT JOIN analytics.current_classifications outcome
    ON outcome.environment = c.environment
   AND outcome.conversation_id = c.id
   AND outcome.dimension = 'final_outcome'
  WHERE c.deleted_at IS NULL
), conversation_daily AS (
SELECT
  (started_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  count(*) AS conversas_total,
  count(*) FILTER (WHERE resultado = 'fechou') AS fecharam,
  count(*) FILTER (WHERE resultado = 'escalou') AS escalaram,
  count(*) FILTER (WHERE resultado IN ('abandonou', 'desistiu_cedo')) AS abandonaram,
  round(
    100.0 * count(*) FILTER (WHERE resultado = 'fechou')
    / NULLIF(count(*), 0),
    1
  ) AS taxa_conversao_pct,
  COALESCE(sum(pedido_total), 0)::numeric AS faturamento,
  round(avg(pedido_total) FILTER (WHERE resultado = 'fechou'), 2) AS ticket_medio,
  round(avg(first_response_seconds) FILTER (WHERE first_response_seconds IS NOT NULL), 0)
    AS resposta_media_seg,
  count(*) FILTER (WHERE periodo_dia = 'madrugada') AS conv_madrugada,
  count(*) FILTER (WHERE periodo_dia = 'manha') AS conv_manha,
  count(*) FILTER (WHERE periodo_dia = 'tarde') AS conv_tarde,
  count(*) FILTER (WHERE periodo_dia = 'noite') AS conv_noite,
  COALESCE(sum(tokens_total), 0)::bigint AS tokens_total,
  round(COALESCE(sum(custo_estimado_brl), 0), 2) AS custo_bot_brl,
  environment
FROM conversation_metrics
GROUP BY environment, (started_at AT TIME ZONE 'America/Sao_Paulo')::date
), sales_daily AS (
  SELECT environment,(realized_at AT TIME ZONE 'America/Sao_Paulo')::date dia,
    count(*) fecharam,sum(total_amount)::numeric faturamento,
    round(avg(total_amount),2) ticket_medio
  FROM analytics.v_bot_realized_orders WHERE realized_at IS NOT NULL
  GROUP BY environment,(realized_at AT TIME ZONE 'America/Sao_Paulo')::date
)
SELECT COALESCE(c.dia,s.dia) dia,COALESCE(c.conversas_total,0) conversas_total,
  COALESCE(s.fecharam,0) fecharam,COALESCE(c.escalaram,0) escalaram,
  COALESCE(c.abandonaram,0) abandonaram,
  round(100.0*COALESCE(s.fecharam,0)/NULLIF(c.conversas_total,0),1) taxa_conversao_pct,
  COALESCE(s.faturamento,0)::numeric faturamento,s.ticket_medio,
  c.resposta_media_seg,COALESCE(c.conv_madrugada,0) conv_madrugada,
  COALESCE(c.conv_manha,0) conv_manha,COALESCE(c.conv_tarde,0) conv_tarde,
  COALESCE(c.conv_noite,0) conv_noite,COALESCE(c.tokens_total,0) tokens_total,
  COALESCE(c.custo_bot_brl,0) custo_bot_brl,COALESCE(c.environment,s.environment) environment
FROM conversation_daily c FULL JOIN sales_daily s ON s.environment=c.environment AND s.dia=c.dia;
COMMENT ON VIEW analytics.v_daily_metrics IS
  '0238: conversas pela data de início; vendas e faturamento pela realização. Reservas e simulador não são faturamento.';
REVOKE ALL ON analytics.v_daily_metrics FROM PUBLIC,farejador_partner_app;
COMMIT;
