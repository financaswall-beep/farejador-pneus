-- 0177 - Restaura os cards diarios do Bot em instalacoes criadas do zero.
--
-- A 0134 recriava analytics.v_daily_metrics apenas quando a view historica
-- analytics.v_conversation_summary ja existia. Essa view nunca fez parte da
-- sequencia greenfield, entao um banco novo terminava sem o resumo consumido
-- pela Matriz. A definicao abaixo usa somente tabelas/views canonicas atuais.

CREATE OR REPLACE VIEW analytics.v_daily_metrics
WITH (security_invoker = true)
AS
WITH conversation_metrics AS (
  SELECT
    c.environment::text AS environment,
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
    FROM commerce.orders o
    WHERE o.environment = c.environment
      AND o.source_conversation_id = c.id
      AND o.status <> 'cancelled'
  ) orders ON true
  LEFT JOIN analytics.current_classifications outcome
    ON outcome.environment = c.environment
   AND outcome.conversation_id = c.id
   AND outcome.dimension = 'final_outcome'
  WHERE c.deleted_at IS NULL
)
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
ORDER BY (started_at AT TIME ZONE 'America/Sao_Paulo')::date DESC;

COMMENT ON VIEW analytics.v_daily_metrics IS
  '0177: resumo diario do Bot derivado apenas do schema greenfield atual; separado por environment e sem dependencia de views historicas.';

REVOKE ALL ON analytics.v_daily_metrics FROM PUBLIC;
REVOKE ALL ON analytics.v_daily_metrics FROM farejador_partner_app;
