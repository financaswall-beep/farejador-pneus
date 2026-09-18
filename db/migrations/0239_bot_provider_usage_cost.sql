-- Contabiliza cada chamada do bot, inclusive respostas descartadas e falhas.
-- Valores de uso observados, sem conteúdo de clientes; moeda-base USD.
BEGIN;
CREATE TABLE ops.bot_model_usage (
  id uuid PRIMARY KEY,
  environment env_t NOT NULL,
  job_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  trigger_message_id uuid NOT NULL,
  response_id text,
  model text NOT NULL,
  service_tier text NOT NULL,
  provider_status text NOT NULL,
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  cached_tokens bigint CHECK (cached_tokens >= 0),
  cache_write_tokens bigint CHECK (cache_write_tokens >= 0),
  estimated_usd numeric(20,10) CHECK (estimated_usd >= 0),
  usd_brl numeric(12,6) NOT NULL CHECK (usd_brl > 0),
  pricing_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cached_tokens + cache_write_tokens <= input_tokens),
  CHECK (estimated_usd IS NULL OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL
    AND cached_tokens IS NOT NULL AND cache_write_tokens IS NOT NULL AND pricing_version IS NOT NULL)),
  UNIQUE(environment,response_id)
);
CREATE INDEX bot_model_usage_period ON ops.bot_model_usage(environment,created_at);
CREATE INDEX bot_model_usage_trigger ON ops.bot_model_usage(environment,trigger_message_id);
ALTER TABLE ops.bot_model_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.bot_model_usage FROM PUBLIC,farejador_partner_app;
COMMENT ON TABLE ops.bot_model_usage IS 'Uso do provedor por tentativa HTTP; sem conteúdo. Custo desconhecido permanece NULL. Não integra o livro financeiro.';

CREATE VIEW analytics.v_bot_usage_daily WITH(security_invoker=true) AS
WITH calls AS (
  SELECT environment,created_at,input_tokens,output_tokens,cached_tokens,cache_write_tokens,
    estimated_usd,usd_brl
  FROM ops.bot_model_usage
  UNION ALL
  -- Histórico sem medição detalhada: não inventar preço/cache nem cobrar duas vezes.
  SELECT t.environment,t.created_at,t.llm_input_tokens,t.llm_output_tokens,NULL::bigint,NULL::bigint,
    NULL::numeric,NULL::numeric
  FROM agent.turns t WHERE t.agent_version='v2' AND NOT EXISTS (
    SELECT 1 FROM ops.bot_model_usage u WHERE u.environment=t.environment
      AND u.trigger_message_id=t.trigger_message_id
  )
)
SELECT environment,(created_at AT TIME ZONE 'America/Sao_Paulo')::date dia,
  count(*) calls,count(*) FILTER (WHERE estimated_usd IS NULL) missing_usage,
  COALESCE(sum(input_tokens),0)::bigint input_tokens,COALESCE(sum(output_tokens),0)::bigint output_tokens,
  COALESCE(sum(cached_tokens),0)::bigint cached_tokens,COALESCE(sum(cache_write_tokens),0)::bigint cache_write_tokens,
  CASE WHEN count(*) FILTER(WHERE estimated_usd IS NULL)=0 THEN COALESCE(sum(estimated_usd),0) END cost_usd,
  CASE WHEN count(*) FILTER(WHERE estimated_usd IS NULL)=0 THEN COALESCE(sum(estimated_usd*usd_brl),0) END cost_brl,
  COALESCE(sum(estimated_usd*usd_brl),0) known_cost_brl,min(usd_brl) usd_brl_min,max(usd_brl) usd_brl_max
FROM calls GROUP BY environment,(created_at AT TIME ZONE 'America/Sao_Paulo')::date;
REVOKE ALL ON analytics.v_bot_usage_daily FROM PUBLIC,farejador_partner_app;

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
SELECT COALESCE(c.dia,s.dia,k.dia) dia,COALESCE(c.conversas_total,0) conversas_total,
  COALESCE(s.fecharam,0) fecharam,COALESCE(c.escalaram,0) escalaram,
  COALESCE(c.abandonaram,0) abandonaram,
  round(100.0*COALESCE(s.fecharam,0)/NULLIF(c.conversas_total,0),1) taxa_conversao_pct,
  COALESCE(s.faturamento,0)::numeric faturamento,s.ticket_medio,
  c.resposta_media_seg,COALESCE(c.conv_madrugada,0) conv_madrugada,
  COALESCE(c.conv_manha,0) conv_manha,COALESCE(c.conv_tarde,0) conv_tarde,
  COALESCE(c.conv_noite,0) conv_noite,
  (COALESCE(k.input_tokens,0)+COALESCE(k.output_tokens,0))::bigint tokens_total,
  CASE WHEN k.missing_usage>0 THEN NULL ELSE COALESCE(k.cost_brl,0) END custo_bot_brl,
  COALESCE(c.environment,s.environment,k.environment) environment,
  CASE WHEN k.missing_usage>0 THEN NULL ELSE COALESCE(k.cost_usd,0) END custo_bot_usd,
  COALESCE(k.missing_usage,0) custo_bot_pendente,COALESCE(k.known_cost_brl,0) custo_bot_parcial_brl,
  k.usd_brl_min cambio_min,k.usd_brl_max cambio_max
FROM conversation_daily c FULL JOIN sales_daily s ON s.environment=c.environment AND s.dia=c.dia
FULL JOIN analytics.v_bot_usage_daily k ON k.environment=COALESCE(c.environment,s.environment)
  AND k.dia=COALESCE(c.dia,s.dia);
COMMENT ON VIEW analytics.v_daily_metrics IS '0239: custo pela data de cada chamada, preços do modelo e câmbio de referência registrado. Uso/preço desconhecido não vira zero; vendas mantêm regra 0238.';
REVOKE ALL ON analytics.v_daily_metrics FROM PUBLIC,farejador_partner_app;
COMMIT;
