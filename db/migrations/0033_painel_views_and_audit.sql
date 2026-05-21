-- ============================================================
-- 0033_painel_views_and_audit.sql
-- Painel Fase 1 — views read-only consumidas pelo painel +
-- tabela ops.human_bot_reviews para verdicts do Shadow.
--
-- O que esta migration faz:
--   1. Cria schema dashboard com views read-only
--   2. Cria ops.human_bot_reviews (verdicts dos pares)
--   3. dashboard.resumo_hoje (KPIs do header)
--   4. dashboard.operacao_ativa (conversas com slots e draft)
--   5. dashboard.shadow_pairs (wrapper sobre ops.human_vs_bot_comparison)
--   6. dashboard.pedidos_recentes (lista pra tela Pedidos)
--
-- Invariantes:
--   - Views NAO sao materializadas (recomputam a cada SELECT)
--   - Reaproveita ops.human_vs_bot_comparison criada em 0031
--   - Painel le destas views; nunca le tabelas crus diretamente
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. Schema dashboard
-- ─────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS dashboard;

COMMENT ON SCHEMA dashboard IS
  'Views read-only consumidas pelo painel humano. Nao escrever aqui.';


-- ------------------------------------------------------------
-- 2. ops.human_bot_reviews
--    Verdicts da fila Shadow do painel.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.human_bot_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     TEXT NOT NULL,
  turn_id         UUID NOT NULL,
  verdict         TEXT NOT NULL,
  notes           TEXT,
  reviewer_label  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT human_bot_reviews_verdict_check
    CHECK (verdict IN ('human_better', 'bot_better', 'equivalent', 'bot_unsure', 'skip')),
  CONSTRAINT human_bot_reviews_turn_fk
    FOREIGN KEY (turn_id) REFERENCES agent.turns(id) ON DELETE CASCADE
);

COMMENT ON TABLE ops.human_bot_reviews IS
  'Verdicts da fila Shadow do painel. Cinco resultados possiveis. Independente da Supervisora batch (que ainda nao roda).';

CREATE INDEX IF NOT EXISTS idx_hbr_turn      ON ops.human_bot_reviews(turn_id);
CREATE INDEX IF NOT EXISTS idx_hbr_verdict   ON ops.human_bot_reviews(verdict);
CREATE INDEX IF NOT EXISTS idx_hbr_created   ON ops.human_bot_reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hbr_reviewer  ON ops.human_bot_reviews(reviewer_label, created_at DESC);

-- Garante que o mesmo turn nao receba dois verdicts finais.
-- "skip" pode ser repetido porque significa apenas pular na triagem.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hbr_turn_unique
  ON ops.human_bot_reviews(turn_id)
  WHERE verdict != 'skip';


-- ─────────────────────────────────────────────
-- 3. dashboard.resumo_hoje
--    KPIs do header: 1 linha, multiplas colunas.
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW dashboard.resumo_hoje AS
SELECT
  c.environment,
  c.unit_id,

  -- Conversas
  (SELECT COUNT(*) FROM core.conversations conv
     WHERE conv.environment = c.environment
       AND conv.started_at::date = CURRENT_DATE
       AND conv.deleted_at IS NULL) AS conversas_hoje,

  -- Vendas registradas
  (SELECT COUNT(*) FROM commerce.orders o
     WHERE o.environment = c.environment
       AND o.created_at::date = CURRENT_DATE
       AND o.source = 'manual'
       AND o.status != 'cancelled') AS vendas_hoje,

  (SELECT COALESCE(SUM(total_amount), 0) FROM commerce.orders o
     WHERE o.environment = c.environment
       AND o.created_at::date = CURRENT_DATE
       AND o.source = 'manual'
       AND o.status != 'cancelled') AS faturamento_hoje,

  -- Drafts aguardando
  (SELECT COUNT(*) FROM agent.order_drafts od
     WHERE od.environment = c.environment
       AND od.draft_status = 'ready'
       AND od.promoted_order_id IS NULL) AS drafts_pendentes,

  -- Pedidos confirmados (qualquer source)
  (SELECT COUNT(*) FROM commerce.orders o
     WHERE o.environment = c.environment
       AND o.created_at::date = CURRENT_DATE
       AND o.status = 'confirmed') AS pedidos_confirmados,

  -- Escalacoes abertas
  (SELECT COUNT(*) FROM agent.escalations e
     WHERE e.environment = c.environment
       AND e.resolved_at IS NULL) AS escalacoes_abertas,

  -- Incidentes nao resolvidos
  (SELECT COUNT(*) FROM ops.agent_incidents inc
     WHERE inc.environment = c.environment
       AND inc.resolved_at IS NULL) AS incidentes_abertos,

  -- Shadow: turns gerados hoje + bloqueados
  (SELECT COUNT(*) FROM agent.turns t
     WHERE t.environment = c.environment
       AND t.created_at::date = CURRENT_DATE) AS shadow_turns_hoje,

  (SELECT COUNT(*) FROM agent.turns t
     WHERE t.environment = c.environment
       AND t.created_at::date = CURRENT_DATE
       AND t.status = 'blocked') AS shadow_blocked_hoje

FROM (SELECT DISTINCT environment, unit_id FROM commerce.orders WHERE unit_id IS NOT NULL
      UNION
      SELECT environment, id FROM core.units WHERE is_active) c;

COMMENT ON VIEW dashboard.resumo_hoje IS
  'KPIs do cartao topo do painel. Uma linha por (environment, unit_id). Recomputada a cada SELECT.';


-- ─────────────────────────────────────────────
-- 4. dashboard.operacao_ativa
--    Conversas vivas com slots agregados e draft.
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW dashboard.operacao_ativa AS
SELECT
  conv.environment,
  conv.id                          AS conversation_id,
  conv.chatwoot_conversation_id,
  conv.channel_type,
  conv.current_status,
  conv.last_activity_at,
  conv.waiting_since,
  ct.id                            AS contact_id,
  ct.name                          AS contact_name,
  ct.phone_e164                    AS contact_phone,
  -- slots agregados como jsonb { slot_key: value }
  (SELECT jsonb_object_agg(slot_key, value_json)
     FROM agent.session_slots ss
     WHERE ss.environment = conv.environment
       AND ss.conversation_id = conv.id) AS slots,
  -- ultima mensagem do cliente (snippet)
  (SELECT content FROM core.messages m
     WHERE m.environment = conv.environment
       AND m.conversation_id = conv.id
       AND m.sender_type = 'contact'
       AND m.is_private = false
       AND m.deleted_at IS NULL
     ORDER BY m.sent_at DESC LIMIT 1) AS last_customer_message,
  -- Draft pronto (se houver)
  od.id                            AS draft_id,
  od.draft_status,
  od.payment_method                AS draft_payment_method,
  od.fulfillment_mode              AS draft_fulfillment_mode,
  od.delivery_address              AS draft_delivery_address,
  od.created_at                    AS draft_created_at
FROM core.conversations conv
LEFT JOIN core.contacts ct
  ON ct.environment = conv.environment AND ct.id = conv.contact_id
LEFT JOIN agent.order_drafts od
  ON od.environment = conv.environment
 AND od.conversation_id = conv.id
 AND od.promoted_order_id IS NULL
WHERE conv.deleted_at IS NULL
  AND COALESCE(conv.current_status, '') NOT IN ('resolved');

COMMENT ON VIEW dashboard.operacao_ativa IS
  'Conversas ainda abertas com slots agregados (do bot) e draft pendente. Base da tela Operacao.';


-- ─────────────────────────────────────────────
-- 5. dashboard.shadow_pairs
--    Wrapper sobre ops.human_vs_bot_comparison
--    (criada em 0031) com colunas que o painel quer.
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW dashboard.shadow_pairs AS
SELECT
  hvb.environment,
  hvb.conversation_id,
  hvb.chatwoot_conversation_id,
  hvb.contact_name,
  hvb.customer_message_id,
  hvb.customer_text,
  hvb.customer_sent_at,
  hvb.human_text,
  hvb.human_sent_at,
  hvb.agent_turn_id,
  hvb.selected_skill,
  hvb.bot_status,
  hvb.bot_text,
  hvb.bot_generated_at,
  hvb.comparison_status,
  hvb.human_reply_seconds,
  hvb.bot_shadow_seconds,
  -- ja foi revisado?
  hbr.id            AS review_id,
  hbr.verdict       AS review_verdict,
  hbr.reviewer_label AS review_by,
  hbr.created_at    AS reviewed_at
FROM ops.human_vs_bot_comparison hvb
LEFT JOIN ops.human_bot_reviews hbr
  ON hbr.turn_id = hvb.agent_turn_id;

COMMENT ON VIEW dashboard.shadow_pairs IS
  'Pares humano vs bot enriquecidos com verdict (se ja revisado). Base da tela Bot/Shadow.';


-- ─────────────────────────────────────────────
-- 6. dashboard.pedidos_recentes
--    Lista plana de pedidos para tela Pedidos.
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW dashboard.pedidos_recentes AS
SELECT
  o.environment,
  o.id                  AS order_id,
  o.created_at,
  o.unit_id,
  u.slug                AS unit_slug,
  u.name                AS unit_name,
  o.contact_id,
  ct.name               AS contact_name,
  ct.phone_e164         AS contact_phone,
  o.source,
  o.status,
  o.payment_method,
  o.fulfillment_mode,
  o.delivery_address,
  o.total_amount,
  o.closed_by           AS registered_by,
  o.closed_at           AS registered_at,
  o.promoted_from_draft_id,
  -- itens agregados
  (SELECT jsonb_agg(jsonb_build_object(
    'product_id', oi.product_id,
    'product_name', p.product_name,
    'product_code', p.product_code,
    'quantity', oi.quantity,
    'unit_price', oi.unit_price,
    'discount_amount', oi.discount_amount,
    'subtotal', (oi.quantity * oi.unit_price - oi.discount_amount)
  ) ORDER BY oi.created_at)
    FROM commerce.order_items oi
    LEFT JOIN commerce.products p ON p.id = oi.product_id AND p.environment = oi.environment
    WHERE oi.order_id = o.id AND oi.environment = o.environment) AS items
FROM commerce.orders o
LEFT JOIN core.units u ON u.id = o.unit_id
LEFT JOIN core.contacts ct ON ct.id = o.contact_id AND ct.environment = o.environment;

COMMENT ON VIEW dashboard.pedidos_recentes IS
  'Pedidos com itens, contato e unidade ja agregados. Painel filtra por data/status/source/unit no SELECT final.';


-- ─────────────────────────────────────────────
-- 6. ops.human_bot_reviews
--    Verdicts da fila Shadow do painel.
-- ─────────────────────────────────────────────
