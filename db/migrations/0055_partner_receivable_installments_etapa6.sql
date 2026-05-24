-- ============================================================
-- 0055_partner_receivable_installments_etapa6.sql
-- Etapa 6 (final) dos consertos de conciliacao do financeiro do Portal Parceiro.
--
-- Adiciona parcelamento de conta a receber: o parceiro pode dividir uma
-- venda "a receber" em N parcelas, cada uma com vencimento e status proprio.
--
-- Modelo:
--   finance.partner_receivable_installments
--     - filha de finance.partner_receivables (ON DELETE CASCADE)
--     - sequence (1, 2, ..., N)
--     - amount, due_date, status, received_at, payment_method
--     - audit padrao (created_at, updated_at, deleted_at)
--
-- Trigger:
--   - Quando todas as parcelas viram 'received', a receivable mae vira
--     'received' (received_at = max(installment.received_at))
--   - Quando todas viram 'cancelled', receivable vira 'cancelled'
--   - Soft-delete em cascade (deletar receivable inativa parcelas via FK CASCADE
--     na delecao fisica; no soft, queries devem filtrar deleted_at na mae)
--
-- Views atualizadas:
--   - network.partner_unit_summary: open_receivables_total agora considera
--     instalments quando existem (substitui receivable.amount)
--   - network.partner_cash_flow_projection: usa due_date das parcelas
--
-- Assinatura: Claude (Opus 4.7), 2026-05-24
-- ============================================================

CREATE TABLE IF NOT EXISTS finance.partner_receivable_installments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  receivable_id   UUID NOT NULL REFERENCES finance.partner_receivables(id) ON DELETE CASCADE,
  sequence        INT NOT NULL CHECK (sequence >= 1),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  due_date        DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'received', 'cancelled')),
  received_at     TIMESTAMPTZ,
  payment_method  TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  deleted_by      TEXT,
  UNIQUE (receivable_id, sequence)
);

CREATE INDEX IF NOT EXISTS partner_receivable_installments_receivable_idx
  ON finance.partner_receivable_installments(receivable_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS partner_receivable_installments_due_idx
  ON finance.partner_receivable_installments(environment, status, due_date)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS partner_receivable_installments_set_updated_at ON finance.partner_receivable_installments;
CREATE TRIGGER partner_receivable_installments_set_updated_at
  BEFORE UPDATE ON finance.partner_receivable_installments
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

-- env_match com a receivable mae
DROP TRIGGER IF EXISTS env_match_partner_receivable_installments_receivable ON finance.partner_receivable_installments;
CREATE TRIGGER env_match_partner_receivable_installments_receivable
  BEFORE INSERT OR UPDATE OF receivable_id ON finance.partner_receivable_installments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('finance', 'partner_receivables', 'receivable_id');

-- RLS: mesma politica da receivable mae (parceiro so ve as suas)
ALTER TABLE finance.partner_receivable_installments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_receivable_installments_isolation ON finance.partner_receivable_installments;
CREATE POLICY partner_receivable_installments_isolation ON finance.partner_receivable_installments
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM finance.partner_receivables pr
      WHERE pr.id = receivable_id
        AND pr.unit_id = network.current_partner_core_unit()
    )
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM finance.partner_receivables pr
      WHERE pr.id = receivable_id
        AND pr.unit_id = network.current_partner_core_unit()
    )
  );

GRANT SELECT, INSERT, UPDATE ON finance.partner_receivable_installments TO farejador_partner_app;

-- ─────────────────────────────────────────────
-- Trigger: auto-fechar receivable quando todas parcelas resolvem
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION finance.partner_receivable_installment_after_update() RETURNS TRIGGER AS $$
DECLARE
  v_total       INT;
  v_received    INT;
  v_cancelled   INT;
  v_max_recv_at TIMESTAMPTZ;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE status = 'received'),
    count(*) FILTER (WHERE status = 'cancelled'),
    max(received_at)
  INTO v_total, v_received, v_cancelled, v_max_recv_at
  FROM finance.partner_receivable_installments
  WHERE receivable_id = NEW.receivable_id
    AND deleted_at IS NULL;

  IF v_total = 0 THEN RETURN NEW; END IF;

  -- Todas resolvidas e pelo menos 1 recebida → receivable=received
  IF v_received + v_cancelled = v_total AND v_received > 0 THEN
    UPDATE finance.partner_receivables
    SET status = 'received',
        received_at = COALESCE(v_max_recv_at, now())
    WHERE id = NEW.receivable_id AND status = 'open';
  -- Todas canceladas → receivable=cancelled
  ELSIF v_cancelled = v_total THEN
    UPDATE finance.partner_receivables
    SET status = 'cancelled'
    WHERE id = NEW.receivable_id AND status = 'open';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS partner_receivable_installment_after_update_trg ON finance.partner_receivable_installments;
CREATE TRIGGER partner_receivable_installment_after_update_trg
  AFTER INSERT OR UPDATE OF status ON finance.partner_receivable_installments
  FOR EACH ROW EXECUTE FUNCTION finance.partner_receivable_installment_after_update();

COMMENT ON TABLE finance.partner_receivable_installments IS
  'Parcelas de finance.partner_receivables. Quando uma receivable tem parcelas, ela vira "grouping" e os totais/vencimentos efetivos vem das parcelas. Trigger fecha receivable mae quando todas parcelas resolvem.';

-- ─────────────────────────────────────────────
-- View helper: receivables efetivas (mae OU parcelas)
-- Usada pelas duas views agregadoras abaixo.
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW finance.partner_receivables_effective
WITH (security_invoker = true) AS
-- Caso 1: receivable SEM parcelas (continua sendo a "linha" efetiva)
SELECT
  pr.id AS receivable_id,
  NULL::uuid AS installment_id,
  pr.environment,
  pr.unit_id,
  pr.amount,
  pr.due_date,
  pr.status,
  pr.received_at,
  pr.source_order_id,
  pr.source_tag,
  pr.created_at
FROM finance.partner_receivables pr
WHERE pr.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM finance.partner_receivable_installments pri
    WHERE pri.receivable_id = pr.id AND pri.deleted_at IS NULL
  )
UNION ALL
-- Caso 2: parcelas de receivables COM parcelas
SELECT
  pri.receivable_id,
  pri.id AS installment_id,
  pri.environment,
  pr.unit_id,
  pri.amount,
  pri.due_date,
  pri.status,
  pri.received_at,
  pr.source_order_id,
  pr.source_tag,
  pri.created_at
FROM finance.partner_receivable_installments pri
JOIN finance.partner_receivables pr ON pr.id = pri.receivable_id
WHERE pri.deleted_at IS NULL AND pr.deleted_at IS NULL;

COMMENT ON VIEW finance.partner_receivables_effective IS
  'Receivables efetivas para agregacao: 1 linha por receivable sem parcelas, ou N linhas (1 por parcela) quando ha parcelas. Usada pelo summary e pelo cash flow.';

GRANT SELECT ON finance.partner_receivables_effective TO farejador_partner_app;

-- ─────────────────────────────────────────────
-- Recria partner_unit_summary para usar receivables_effective
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW network.partner_unit_summary
WITH (security_invoker = true) AS
WITH month_bounds AS (
  SELECT
    (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS month_start_at,
    date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date AS month_start_date
)
SELECT
  pu.environment,
  pu.id AS partner_unit_id,
  pu.unit_id,
  pu.slug,
  pu.display_name,
  p.id AS partner_id,
  p.trade_name AS partner_name,
  p.status AS partner_status,
  pu.status AS unit_status,

  COALESCE(orders_month.total_sales, 0)        AS sales_month,
  COALESCE(orders_month.order_count, 0)        AS orders_month,
  COALESCE(purchases_month.total_purchases, 0) AS purchases_month,
  COALESCE(expenses_month.total_expenses, 0)   AS expenses_month,
  COALESCE(orders_month.total_sales, 0)
    - COALESCE(purchases_month.total_purchases, 0)
    - COALESCE(expenses_month.total_expenses, 0) AS result_competencia_month,
  COALESCE(orders_month.total_sales, 0)
    - COALESCE(purchases_month.total_purchases, 0)
    - COALESCE(expenses_month.total_expenses, 0) AS estimated_result_month,

  COALESCE(cash_in_month.total, 0)             AS cash_in_month,
  COALESCE(cash_out_month.total, 0)            AS cash_out_month,
  COALESCE(cash_in_month.total, 0)
    - COALESCE(cash_out_month.total, 0)        AS cash_net_month,

  COALESCE(open_recv.total, 0)                 AS open_receivables_total,
  COALESCE(open_pay.total, 0)                  AS open_payables_total,
  COALESCE(open_recv.total, 0)
    - COALESCE(open_pay.total, 0)              AS net_future_position,

  COALESCE(stock_counts.stock_items, 0)        AS stock_items,
  COALESCE(stock_counts.low_stock_items, 0)    AS low_stock_items
FROM network.partner_units pu
JOIN network.partners p
  ON p.id = pu.partner_id AND p.environment = pu.environment
CROSS JOIN month_bounds mb

LEFT JOIN LATERAL (
  SELECT count(*)::int AS order_count, COALESCE(sum(total_amount), 0) AS total_sales
  FROM commerce.partner_orders po
  WHERE po.environment = pu.environment AND po.unit_id = pu.unit_id
    AND po.status <> 'cancelled' AND po.deleted_at IS NULL
    AND po.created_at >= mb.month_start_at
) orders_month ON true

LEFT JOIN LATERAL (
  SELECT COALESCE(sum(total_amount), 0) AS total_purchases
  FROM commerce.partner_purchases pp
  WHERE pp.environment = pu.environment AND pp.unit_id = pu.unit_id
    AND pp.purchased_at >= mb.month_start_at AND pp.deleted_at IS NULL
) purchases_month ON true

LEFT JOIN LATERAL (
  SELECT COALESCE(sum(amount), 0) AS total_expenses
  FROM finance.partner_expenses pe
  WHERE pe.environment = pu.environment AND pe.unit_id = pu.unit_id
    AND pe.expense_date >= mb.month_start_date AND pe.deleted_at IS NULL
) expenses_month ON true

-- Cash in: vendas a vista + receivables EFETIVAS recebidas no mes
LEFT JOIN LATERAL (
  SELECT (
    COALESCE((
      SELECT sum(total_amount)
      FROM commerce.partner_orders po
      WHERE po.environment = pu.environment AND po.unit_id = pu.unit_id
        AND po.status <> 'cancelled' AND po.deleted_at IS NULL
        AND po.created_at >= mb.month_start_at
        AND (po.payment_method IS NULL OR po.payment_method <> 'A receber')
    ), 0)
    +
    COALESCE((
      SELECT sum(amount)
      FROM finance.partner_receivables_effective pre
      WHERE pre.environment = pu.environment AND pre.unit_id = pu.unit_id
        AND pre.status = 'received'
        AND pre.received_at >= mb.month_start_at
    ), 0)
  ) AS total
) cash_in_month ON true

-- Cash out: compras paid_now + despesas manuais + payables pagos
LEFT JOIN LATERAL (
  SELECT (
    COALESCE((
      SELECT sum(total_amount)
      FROM commerce.partner_purchases pp
      WHERE pp.environment = pu.environment AND pp.unit_id = pu.unit_id
        AND pp.deleted_at IS NULL AND pp.purchased_at >= mb.month_start_at
        AND pp.payment_status = 'paid_now'
    ), 0)
    +
    COALESCE((
      SELECT sum(amount)
      FROM finance.partner_expenses pe
      WHERE pe.environment = pu.environment AND pe.unit_id = pu.unit_id
        AND pe.deleted_at IS NULL AND pe.expense_date >= mb.month_start_date
        AND pe.source_payable_id IS NULL
    ), 0)
    +
    COALESCE((
      SELECT sum(amount)
      FROM finance.partner_payables pp2
      WHERE pp2.environment = pu.environment AND pp2.unit_id = pu.unit_id
        AND pp2.deleted_at IS NULL AND pp2.status = 'paid'
        AND pp2.paid_at >= mb.month_start_at
    ), 0)
  ) AS total
) cash_out_month ON true

-- Open receivables (EFETIVAS): sem parcela usa receivable.amount, com parcela usa sum das parcelas em aberto
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(amount), 0) AS total
  FROM finance.partner_receivables_effective pre
  WHERE pre.environment = pu.environment AND pre.unit_id = pu.unit_id
    AND pre.status = 'open'
) open_recv ON true

LEFT JOIN LATERAL (
  SELECT COALESCE(sum(amount), 0) AS total
  FROM finance.partner_payables pp3
  WHERE pp3.environment = pu.environment AND pp3.unit_id = pu.unit_id
    AND pp3.status = 'open' AND pp3.deleted_at IS NULL
) open_pay ON true

LEFT JOIN LATERAL (
  SELECT count(*)::int AS stock_items,
         count(*) FILTER (WHERE stock_status IN ('low_stock', 'out_of_stock'))::int AS low_stock_items
  FROM commerce.partner_stock_levels ps
  WHERE ps.environment = pu.environment AND ps.unit_id = pu.unit_id
    AND ps.deleted_at IS NULL
) stock_counts ON true

WHERE pu.deleted_at IS NULL;

-- ─────────────────────────────────────────────
-- Recria cash_flow_projection usando receivables_effective
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW network.partner_cash_flow_projection
WITH (security_invoker = true) AS
WITH today_bound AS (
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS today
),
recv AS (
  SELECT
    pre.environment,
    pre.unit_id,
    CASE
      WHEN pre.due_date IS NULL THEN 'later'
      WHEN pre.due_date <  tb.today THEN 'overdue'
      WHEN pre.due_date =  tb.today THEN 'today'
      WHEN pre.due_date <= tb.today + 7  THEN 'next_7d'
      WHEN pre.due_date <= tb.today + 30 THEN 'next_30d'
      ELSE 'later'
    END AS bucket,
    pre.amount
  FROM finance.partner_receivables_effective pre
  CROSS JOIN today_bound tb
  WHERE pre.status = 'open'
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
  SELECT environment, unit_id,
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
  FROM recv GROUP BY environment, unit_id
),
pay_agg AS (
  SELECT environment, unit_id,
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
  FROM pay GROUP BY environment, unit_id
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
