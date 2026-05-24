-- ============================================================
-- 0054_partner_cash_flow_projection_etapa5.sql
-- Etapa 5 dos consertos de conciliacao do financeiro do Portal Parceiro.
--
-- Cria network.partner_cash_flow_projection: 1 linha por unidade parceira,
-- agregando todos os payables e receivables em aberto (status='open')
-- por bucket de vencimento.
--
-- Buckets (em America/Sao_Paulo):
--   overdue  : due_date <  hoje
--   today    : due_date =  hoje
--   next_7d  : hoje <  due_date <= hoje + 7
--   next_30d : hoje + 7  <  due_date <= hoje + 30
--   later    : due_date >  hoje + 30  OU  due_date IS NULL
--
-- Para cada bucket: colunas _in (receivables) e _out (payables) em R$,
-- e _count (numero de contas). Mais a soma _net = in - out por bucket.
--
-- View tem security_invoker=true para preservar RLS estrita do parceiro.
--
-- Assinatura: Claude (Opus 4.7), 2026-05-24
-- ============================================================

CREATE OR REPLACE VIEW network.partner_cash_flow_projection
WITH (security_invoker = true) AS
WITH today_bound AS (
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS today
),
recv AS (
  SELECT
    pr.environment,
    pr.unit_id,
    CASE
      WHEN pr.due_date IS NULL THEN 'later'
      WHEN pr.due_date <  tb.today THEN 'overdue'
      WHEN pr.due_date =  tb.today THEN 'today'
      WHEN pr.due_date <= tb.today + 7  THEN 'next_7d'
      WHEN pr.due_date <= tb.today + 30 THEN 'next_30d'
      ELSE 'later'
    END AS bucket,
    pr.amount
  FROM finance.partner_receivables pr
  CROSS JOIN today_bound tb
  WHERE pr.status = 'open' AND pr.deleted_at IS NULL
),
pay AS (
  SELECT
    pp.environment,
    pp.unit_id,
    CASE
      WHEN pp.due_date IS NULL THEN 'later'
      WHEN pp.due_date <  tb.today THEN 'overdue'
      WHEN pp.due_date =  tb.today THEN 'today'
      WHEN pp.due_date <= tb.today + 7  THEN 'next_7d'
      WHEN pp.due_date <= tb.today + 30 THEN 'next_30d'
      ELSE 'later'
    END AS bucket,
    pp.amount
  FROM finance.partner_payables pp
  CROSS JOIN today_bound tb
  WHERE pp.status = 'open' AND pp.deleted_at IS NULL
),
recv_agg AS (
  SELECT
    environment,
    unit_id,
    COALESCE(sum(amount) FILTER (WHERE bucket='overdue'), 0)  AS overdue_in,
    COALESCE(sum(amount) FILTER (WHERE bucket='today'), 0)    AS today_in,
    COALESCE(sum(amount) FILTER (WHERE bucket='next_7d'), 0)  AS next_7d_in,
    COALESCE(sum(amount) FILTER (WHERE bucket='next_30d'), 0) AS next_30d_in,
    COALESCE(sum(amount) FILTER (WHERE bucket='later'), 0)    AS later_in,
    count(*) FILTER (WHERE bucket='overdue')::int  AS overdue_in_count,
    count(*) FILTER (WHERE bucket='today')::int    AS today_in_count,
    count(*) FILTER (WHERE bucket='next_7d')::int  AS next_7d_in_count,
    count(*) FILTER (WHERE bucket='next_30d')::int AS next_30d_in_count,
    count(*) FILTER (WHERE bucket='later')::int    AS later_in_count
  FROM recv
  GROUP BY environment, unit_id
),
pay_agg AS (
  SELECT
    environment,
    unit_id,
    COALESCE(sum(amount) FILTER (WHERE bucket='overdue'), 0)  AS overdue_out,
    COALESCE(sum(amount) FILTER (WHERE bucket='today'), 0)    AS today_out,
    COALESCE(sum(amount) FILTER (WHERE bucket='next_7d'), 0)  AS next_7d_out,
    COALESCE(sum(amount) FILTER (WHERE bucket='next_30d'), 0) AS next_30d_out,
    COALESCE(sum(amount) FILTER (WHERE bucket='later'), 0)    AS later_out,
    count(*) FILTER (WHERE bucket='overdue')::int  AS overdue_out_count,
    count(*) FILTER (WHERE bucket='today')::int    AS today_out_count,
    count(*) FILTER (WHERE bucket='next_7d')::int  AS next_7d_out_count,
    count(*) FILTER (WHERE bucket='next_30d')::int AS next_30d_out_count,
    count(*) FILTER (WHERE bucket='later')::int    AS later_out_count
  FROM pay
  GROUP BY environment, unit_id
)
SELECT
  pu.environment,
  pu.id AS partner_unit_id,
  pu.unit_id,
  pu.slug,

  COALESCE(r.overdue_in, 0)   AS overdue_in,
  COALESCE(p.overdue_out, 0)  AS overdue_out,
  COALESCE(r.overdue_in, 0) - COALESCE(p.overdue_out, 0)   AS overdue_net,
  COALESCE(r.overdue_in_count, 0)  AS overdue_in_count,
  COALESCE(p.overdue_out_count, 0) AS overdue_out_count,

  COALESCE(r.today_in, 0)     AS today_in,
  COALESCE(p.today_out, 0)    AS today_out,
  COALESCE(r.today_in, 0) - COALESCE(p.today_out, 0)       AS today_net,
  COALESCE(r.today_in_count, 0)    AS today_in_count,
  COALESCE(p.today_out_count, 0)   AS today_out_count,

  COALESCE(r.next_7d_in, 0)   AS next_7d_in,
  COALESCE(p.next_7d_out, 0)  AS next_7d_out,
  COALESCE(r.next_7d_in, 0) - COALESCE(p.next_7d_out, 0)   AS next_7d_net,
  COALESCE(r.next_7d_in_count, 0)  AS next_7d_in_count,
  COALESCE(p.next_7d_out_count, 0) AS next_7d_out_count,

  COALESCE(r.next_30d_in, 0)  AS next_30d_in,
  COALESCE(p.next_30d_out, 0) AS next_30d_out,
  COALESCE(r.next_30d_in, 0) - COALESCE(p.next_30d_out, 0) AS next_30d_net,
  COALESCE(r.next_30d_in_count, 0)  AS next_30d_in_count,
  COALESCE(p.next_30d_out_count, 0) AS next_30d_out_count,

  COALESCE(r.later_in, 0)     AS later_in,
  COALESCE(p.later_out, 0)    AS later_out,
  COALESCE(r.later_in, 0) - COALESCE(p.later_out, 0)       AS later_net,
  COALESCE(r.later_in_count, 0)    AS later_in_count,
  COALESCE(p.later_out_count, 0)   AS later_out_count
FROM network.partner_units pu
LEFT JOIN recv_agg r ON r.environment = pu.environment AND r.unit_id = pu.unit_id
LEFT JOIN pay_agg  p ON p.environment = pu.environment AND p.unit_id = pu.unit_id
WHERE pu.deleted_at IS NULL;

COMMENT ON VIEW network.partner_cash_flow_projection IS
  'Projecao de fluxo de caixa do Portal Parceiro. Agrupa payables/receivables em aberto por bucket de vencimento (overdue/today/next_7d/next_30d/later). Tudo em America/Sao_Paulo.';
