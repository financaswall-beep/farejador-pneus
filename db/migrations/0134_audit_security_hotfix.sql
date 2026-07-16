-- 0134 - Hotfix independente da Folha.
-- Pode ser aplicado sobre o schema atual ate a 0132: fecha o bypass de RLS,
-- corrige datas de clientes e separa prod/test nas views analiticas legadas.

-- A 0090 recriou a view e perdeu security_invoker da 0058. Sem esta opcao,
-- SELECT pela role do parceiro executa como dono da view e contorna a RLS.
DO $$
BEGIN
  IF to_regclass('commerce.partner_orders_full') IS NOT NULL THEN
    ALTER VIEW commerce.partner_orders_full SET (security_invoker = true);
  END IF;
END $$;

-- Primeira/ultima compra seguem a mesma regra dos totais: cancelada nao conta.
CREATE OR REPLACE VIEW commerce.customer_profile AS
SELECT
  contact_id,
  environment,
  COUNT(*) FILTER (WHERE status != 'cancelled') AS total_orders,
  SUM(total_amount) FILTER (WHERE status != 'cancelled') AS total_spent,
  AVG(total_amount) FILTER (WHERE status != 'cancelled') AS avg_ticket,
  MIN(created_at) FILTER (WHERE status != 'cancelled') AS first_order_at,
  MAX(created_at) FILTER (WHERE status != 'cancelled') AS last_order_at,
  COUNT(DISTINCT geo_resolution_id) FILTER (WHERE status != 'cancelled') AS distinct_delivery_zones,
  ARRAY_AGG(DISTINCT payment_method) FILTER (WHERE status != 'cancelled' AND payment_method IS NOT NULL) AS used_payment_methods,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
  COUNT(*) FILTER (WHERE status != 'cancelled' AND created_at > now() - interval '90 days') AS orders_last_90d,
  COUNT(*) AS total_orders_including_cancelled
FROM commerce.orders
GROUP BY contact_id, environment;

-- Estas views sao legadas de producao e nao existem em toda instalacao nova.
-- A migration continua aplicavel do zero e tambem como hotfix isolado.
DO $migration$
BEGIN
  IF to_regclass('analytics.v_conversation_summary') IS NOT NULL THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW analytics.v_daily_metrics AS
      SELECT
        (started_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
        count(*) AS conversas_total,
        count(*) FILTER (WHERE resultado = 'fechou') AS fecharam,
        count(*) FILTER (WHERE resultado = 'escalou') AS escalaram,
        count(*) FILTER (WHERE resultado IN ('abandonou','desistiu_cedo')) AS abandonaram,
        round(100.0 * count(*) FILTER (WHERE resultado = 'fechou') / NULLIF(count(*), 0), 1) AS taxa_conversao_pct,
        COALESCE(sum(pedido_total), 0) AS faturamento,
        round(avg(pedido_total) FILTER (WHERE resultado = 'fechou'), 2) AS ticket_medio,
        round(avg(first_response_seconds), 0) AS resposta_media_seg,
        count(*) FILTER (WHERE periodo_dia = 'madrugada') AS conv_madrugada,
        count(*) FILTER (WHERE periodo_dia = 'manha') AS conv_manha,
        count(*) FILTER (WHERE periodo_dia = 'tarde') AS conv_tarde,
        count(*) FILTER (WHERE periodo_dia = 'noite') AS conv_noite,
        COALESCE(sum(tokens_total), 0) AS tokens_total,
        round(sum(custo_estimado_brl), 2) AS custo_bot_brl,
        environment
      FROM analytics.v_conversation_summary
      GROUP BY environment, (started_at AT TIME ZONE 'America/Sao_Paulo')::date
      ORDER BY (started_at AT TIME ZONE 'America/Sao_Paulo')::date DESC
    $view$;
  END IF;

  IF to_regclass('analytics.v_clientes_pra_recuperar') IS NOT NULL THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW analytics.v_clientes_pra_recuperar AS
      SELECT
        c.chatwoot_conversation_id,
        ct.name AS cliente_nome,
        ct.phone_e164 AS cliente_telefone,
        c.started_at,
        EXTRACT(epoch FROM now() - c.last_activity_at) / 3600::numeric AS horas_sem_resposta,
        (SELECT f.fact_value ->> 0 FROM analytics.conversation_facts f
          WHERE f.environment=c.environment AND f.conversation_id=c.id AND f.fact_key='moto_modelo_consultado' LIMIT 1) AS moto,
        (SELECT f.fact_value ->> 0 FROM analytics.conversation_facts f
          WHERE f.environment=c.environment AND f.conversation_id=c.id AND f.fact_key='bairro_consultado' LIMIT 1) AS bairro,
        (SELECT f.fact_value ->> 0 FROM analytics.conversation_facts f
          WHERE f.environment=c.environment AND f.conversation_id=c.id AND f.fact_key='preco_cotado'
          ORDER BY f.observed_at DESC LIMIT 1) AS ultimo_preco_cotado,
        (SELECT cc.value FROM analytics.conversation_classifications cc
          WHERE cc.environment=c.environment AND cc.conversation_id=c.id AND cc.dimension='stage_reached' LIMIT 1) AS etapa_atingida,
        (SELECT cc.value FROM analytics.conversation_classifications cc
          WHERE cc.environment=c.environment AND cc.conversation_id=c.id AND cc.dimension='loss_reason' LIMIT 1) AS provavel_motivo,
        EXISTS (SELECT 1 FROM analytics.linguistic_hints h
          WHERE h.environment=c.environment AND h.conversation_id=c.id AND h.hint_type='objecao_preco') AS reclamou_preco,
        EXISTS (SELECT 1 FROM analytics.linguistic_hints h
          WHERE h.environment=c.environment AND h.conversation_id=c.id AND h.hint_type='mencao_concorrente') AS mencionou_concorrente,
        c.environment
      FROM core.conversations c
      LEFT JOIN core.contacts ct ON ct.id=c.contact_id AND ct.environment=c.environment
      WHERE c.deleted_at IS NULL AND ct.name IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM commerce.orders o
                         WHERE o.environment=c.environment AND o.source_conversation_id=c.id)
        AND c.last_activity_at < now() - interval '1 hour'
        AND c.last_activity_at > now() - interval '7 days'
      ORDER BY c.last_activity_at DESC
    $view$;
  END IF;
END
$migration$;
