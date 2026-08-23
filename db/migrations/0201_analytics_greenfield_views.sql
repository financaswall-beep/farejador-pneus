-- ============================================================
-- 0201 - Fecha o buraco do banco NOVO: as 2 peças de analytics
--        que a produção tem e a sequência greenfield não criava.
--
-- ACHADO (2026-08-22): reconstruir as 201 migrations num Postgres 17
-- vazio e comparar peça a peça com a produção mostrou 2 objetos que
-- EXISTEM em prod, são LIDOS pelo código, e não nascem de migration
-- nenhuma (foram criados à mão e nunca versionados):
--
--   analytics.customer_journey_mv    <- src/atendente-v2/agent.ts:54  (o BOT)
--   analytics.v_clientes_pra_recuperar <- src/admin/painel/queries-rede-resumo.ts:160
--
-- Num banco criado do zero o bot quebraria no atendimento e a aba
-- Resumo/Rede viria vazia. É a MESMA classe de bug que a 0177 já tinha
-- consertado para analytics.v_daily_metrics — só que faltou o resto.
--
-- Junto vai o agendamento noturno do REFRESH: sem ele a matview nasce
-- e CONGELA no dia da criação (o bot leria um retrato velho pra sempre).
--
-- Definições copiadas VERBATIM de prod (pg_get_viewdef) — esta migration
-- não melhora nada, só registra o que já existe. Idempotente: em prod é
-- no-op, em banco novo constrói.
--
-- Ressalva registrada (NÃO tratada aqui de propósito): as duas nasceram
-- sem `security_invoker`, ao contrário do padrão pós-0134/0177. Hoje não
-- há caminho de vazamento — nenhum grant fora do owner `postgres`, e o
-- papel farejador_partner_app não enxerga analytics. Endurecer isso é
-- migration própria; misturar com este conserto é que seria arriscado.
--
-- Fora de escopo DE PROPÓSITO: analytics.conversation_signals_mv,
-- v_conversation_summary, v_top_bairros, v_top_motos e v_top_produtos.
-- Existem em prod, dependem umas das outras, e NENHUMA é referenciada
-- pelo código (varredura em src/). São órfãs: não vale ressuscitar.
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.customer_journey_mv AS
 SELECT c.contact_id,
    c.environment,
    count(DISTINCT c.id)::integer AS total_conversations,
    min(c.started_at) AS first_conversation_at,
    max(c.started_at) AS last_conversation_at,
    count(DISTINCT c.id) > 1 AS is_returning,
    EXTRACT(day FROM now() - min(c.started_at))::integer AS days_since_first,
    COALESCE(max(o.purchase_count), 0::bigint)::integer AS purchase_count,
    COALESCE(max(o.partial_ltv_brl), 0::numeric)::numeric(12,2) AS partial_ltv_brl,
    now() AS computed_at
   FROM core.conversations c
     LEFT JOIN LATERAL ( SELECT count(*) AS purchase_count,
            sum(ord.total_amount) AS partial_ltv_brl
           FROM commerce.orders ord
          WHERE ord.contact_id = c.contact_id) o ON true
  WHERE c.contact_id IS NOT NULL AND c.deleted_at IS NULL
  GROUP BY c.contact_id, c.environment;

-- Índice único: é o que habilita REFRESH ... CONCURRENTLY (sem ele o
-- refresh noturno TRAVA a leitura do bot enquanto roda).
CREATE UNIQUE INDEX IF NOT EXISTS customer_journey_mv_contact_id_idx
  ON analytics.customer_journey_mv USING btree (contact_id);

CREATE OR REPLACE VIEW analytics.v_clientes_pra_recuperar AS
 SELECT c.chatwoot_conversation_id,
    ct.name AS cliente_nome,
    ct.phone_e164 AS cliente_telefone,
    c.started_at,
    EXTRACT(epoch FROM now() - c.last_activity_at) / 3600::numeric AS horas_sem_resposta,
    ( SELECT f.fact_value ->> 0
           FROM analytics.conversation_facts f
          WHERE f.environment::text = c.environment::text AND f.conversation_id = c.id AND f.fact_key = 'moto_modelo_consultado'::text
         LIMIT 1) AS moto,
    ( SELECT f.fact_value ->> 0
           FROM analytics.conversation_facts f
          WHERE f.environment::text = c.environment::text AND f.conversation_id = c.id AND f.fact_key = 'bairro_consultado'::text
         LIMIT 1) AS bairro,
    ( SELECT f.fact_value ->> 0
           FROM analytics.conversation_facts f
          WHERE f.environment::text = c.environment::text AND f.conversation_id = c.id AND f.fact_key = 'preco_cotado'::text
          ORDER BY f.observed_at DESC
         LIMIT 1) AS ultimo_preco_cotado,
    ( SELECT cc.value
           FROM analytics.conversation_classifications cc
          WHERE cc.environment::text = c.environment::text AND cc.conversation_id = c.id AND cc.dimension = 'stage_reached'::text
         LIMIT 1) AS etapa_atingida,
    ( SELECT cc.value
           FROM analytics.conversation_classifications cc
          WHERE cc.environment::text = c.environment::text AND cc.conversation_id = c.id AND cc.dimension = 'loss_reason'::text
         LIMIT 1) AS provavel_motivo,
    (EXISTS ( SELECT 1
           FROM analytics.linguistic_hints h
          WHERE h.environment::text = c.environment::text AND h.conversation_id = c.id AND h.hint_type = 'objecao_preco'::text)) AS reclamou_preco,
    (EXISTS ( SELECT 1
           FROM analytics.linguistic_hints h
          WHERE h.environment::text = c.environment::text AND h.conversation_id = c.id AND h.hint_type = 'mencao_concorrente'::text)) AS mencionou_concorrente,
    c.environment
   FROM core.conversations c
     LEFT JOIN core.contacts ct ON ct.id = c.contact_id AND ct.environment::text = c.environment::text
  WHERE c.deleted_at IS NULL AND ct.name IS NOT NULL AND NOT (EXISTS ( SELECT 1
           FROM commerce.orders o
          WHERE o.environment::text = c.environment::text AND o.source_conversation_id = c.id)) AND c.last_activity_at < (now() - '01:00:00'::interval) AND c.last_activity_at > (now() - '7 days'::interval)
  ORDER BY c.last_activity_at DESC;

-- Mesmo nome/horário do job que já roda em prod hoje (03:15 UTC).
-- cron.schedule com o mesmo nome atualiza o job — idempotente, padrão da 0096.
SELECT cron.schedule(
  'analytics-journey-refresh',
  '15 3 * * *',
  $$ REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.customer_journey_mv $$
);

-- ============================================================
-- SMOKE DENTRO DA MIGRATION: se qualquer peça não subir, aborta.
-- ============================================================
DO $smoke$
BEGIN
  IF to_regclass('analytics.customer_journey_mv') IS NULL THEN
    RAISE EXCEPTION 'smoke 0201: analytics.customer_journey_mv nao existe';
  END IF;

  IF to_regclass('analytics.v_clientes_pra_recuperar') IS NULL THEN
    RAISE EXCEPTION 'smoke 0201: analytics.v_clientes_pra_recuperar nao existe';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'analytics'
       AND indexname = 'customer_journey_mv_contact_id_idx'
  ) THEN
    RAISE EXCEPTION 'smoke 0201: indice unico ausente — REFRESH CONCURRENTLY quebraria';
  END IF;

  -- Executáveis de verdade (pega coluna quebrada, não só existência).
  PERFORM 1 FROM analytics.customer_journey_mv LIMIT 1;
  PERFORM 1 FROM analytics.v_clientes_pra_recuperar LIMIT 1;
END
$smoke$;
