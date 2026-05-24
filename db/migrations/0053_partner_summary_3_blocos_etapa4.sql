-- ============================================================
-- 0053_partner_summary_3_blocos_etapa4.sql
-- Etapa 4 dos consertos de conciliacao do financeiro do Portal Parceiro.
--
-- Reescreve network.partner_unit_summary para responder 3 perguntas
-- separadas em vez de misturar regimes:
--
--   1. COMPETENCIA do mes (o que aconteceu):
--      sales_month, purchases_month, expenses_month, result_competencia_month
--      (mantem campos legados: estimated_result_month = result_competencia_month)
--
--   2. CAIXA REALIZADO do mes (o que entrou/saiu de verdade):
--      cash_in_month   = vendas pagas na hora + receivables recebidos
--      cash_out_month  = compras pagas na hora + despesas manuais + payables pagos
--      cash_net_month  = cash_in - cash_out
--
--   3. POSICAO FUTURA (compromissos em aberto, sem janela temporal):
--      open_receivables_total, open_payables_total, net_future_position
--
-- Regras anti-dupla-contagem (alinhadas com Etapas 1-3):
--   - cash_out NAO conta expense quando ela tem source_payable_id (o evento
--     de caixa eh o payable.paid_at, nao a expense)
--   - cash_in vendas filtra payment_method <> 'A receber' (essas geram
--     receivable, cash entra so quando receivable.received_at)
--   - cash_out compras filtra payment_status='paid_now' (a prazo gera payable)
--
-- Mantem todos os campos antigos para compatibilidade com UI atual.
--
-- Assinatura: Claude (Opus 4.7), 2026-05-24
-- ============================================================

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

  -- ─── Bloco 1: COMPETENCIA ──────────────────────────────
  COALESCE(orders_month.total_sales, 0)        AS sales_month,
  COALESCE(orders_month.order_count, 0)        AS orders_month,
  COALESCE(purchases_month.total_purchases, 0) AS purchases_month,
  COALESCE(expenses_month.total_expenses, 0)   AS expenses_month,
  COALESCE(orders_month.total_sales, 0)
    - COALESCE(purchases_month.total_purchases, 0)
    - COALESCE(expenses_month.total_expenses, 0) AS result_competencia_month,
  -- Campo legado mantido para compatibilidade com UI atual:
  COALESCE(orders_month.total_sales, 0)
    - COALESCE(purchases_month.total_purchases, 0)
    - COALESCE(expenses_month.total_expenses, 0) AS estimated_result_month,

  -- ─── Bloco 2: CAIXA REALIZADO ──────────────────────────
  COALESCE(cash_in_month.total, 0)             AS cash_in_month,
  COALESCE(cash_out_month.total, 0)            AS cash_out_month,
  COALESCE(cash_in_month.total, 0)
    - COALESCE(cash_out_month.total, 0)        AS cash_net_month,

  -- ─── Bloco 3: POSICAO FUTURA ───────────────────────────
  COALESCE(open_recv.total, 0)                 AS open_receivables_total,
  COALESCE(open_pay.total, 0)                  AS open_payables_total,
  COALESCE(open_recv.total, 0)
    - COALESCE(open_pay.total, 0)              AS net_future_position,

  -- ─── Estoque (legado, sem mudanca) ─────────────────────
  COALESCE(stock_counts.stock_items, 0)        AS stock_items,
  COALESCE(stock_counts.low_stock_items, 0)    AS low_stock_items
FROM network.partner_units pu
JOIN network.partners p
  ON p.id = pu.partner_id AND p.environment = pu.environment
CROSS JOIN month_bounds mb

-- Vendas confirmadas do mes (competencia)
LEFT JOIN LATERAL (
  SELECT count(*)::int AS order_count, COALESCE(sum(total_amount), 0) AS total_sales
  FROM commerce.partner_orders po
  WHERE po.environment = pu.environment
    AND po.unit_id = pu.unit_id
    AND po.status <> 'cancelled'
    AND po.deleted_at IS NULL
    AND po.created_at >= mb.month_start_at
) orders_month ON true

-- Compras do mes (competencia, todas)
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(total_amount), 0) AS total_purchases
  FROM commerce.partner_purchases pp
  WHERE pp.environment = pu.environment
    AND pp.unit_id = pu.unit_id
    AND pp.purchased_at >= mb.month_start_at
    AND pp.deleted_at IS NULL
) purchases_month ON true

-- Despesas do mes (competencia, todas)
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(amount), 0) AS total_expenses
  FROM finance.partner_expenses pe
  WHERE pe.environment = pu.environment
    AND pe.unit_id = pu.unit_id
    AND pe.expense_date >= mb.month_start_date
    AND pe.deleted_at IS NULL
) expenses_month ON true

-- Caixa-in do mes: vendas a vista + receivables recebidas
LEFT JOIN LATERAL (
  SELECT (
    -- Vendas pagas no ato (nao "a receber")
    COALESCE((
      SELECT sum(total_amount)
      FROM commerce.partner_orders po
      WHERE po.environment = pu.environment
        AND po.unit_id = pu.unit_id
        AND po.status <> 'cancelled'
        AND po.deleted_at IS NULL
        AND po.created_at >= mb.month_start_at
        AND (po.payment_method IS NULL OR po.payment_method <> 'A receber')
    ), 0)
    +
    -- Receivables recebidas no mes (inclui as criadas em meses anteriores)
    COALESCE((
      SELECT sum(amount)
      FROM finance.partner_receivables pr
      WHERE pr.environment = pu.environment
        AND pr.unit_id = pu.unit_id
        AND pr.status = 'received'
        AND pr.deleted_at IS NULL
        AND pr.received_at >= mb.month_start_at
    ), 0)
  ) AS total
) cash_in_month ON true

-- Caixa-out do mes: compras pagas no ato + despesas manuais + payables pagos
LEFT JOIN LATERAL (
  SELECT (
    -- Compras pagas no ato
    COALESCE((
      SELECT sum(total_amount)
      FROM commerce.partner_purchases pp
      WHERE pp.environment = pu.environment
        AND pp.unit_id = pu.unit_id
        AND pp.deleted_at IS NULL
        AND pp.purchased_at >= mb.month_start_at
        AND pp.payment_status = 'paid_now'
    ), 0)
    +
    -- Despesas manuais (que NAO foram geradas por settlePayable)
    COALESCE((
      SELECT sum(amount)
      FROM finance.partner_expenses pe
      WHERE pe.environment = pu.environment
        AND pe.unit_id = pu.unit_id
        AND pe.deleted_at IS NULL
        AND pe.expense_date >= mb.month_start_date
        AND pe.source_payable_id IS NULL
    ), 0)
    +
    -- Payables pagos no mes (inclui os criados em meses anteriores).
    -- Cobre tanto rent/employee manual quanto compra-a-prazo paga este mes.
    COALESCE((
      SELECT sum(amount)
      FROM finance.partner_payables pp2
      WHERE pp2.environment = pu.environment
        AND pp2.unit_id = pu.unit_id
        AND pp2.deleted_at IS NULL
        AND pp2.status = 'paid'
        AND pp2.paid_at >= mb.month_start_at
    ), 0)
  ) AS total
) cash_out_month ON true

-- Posicao futura: receivables em aberto (sem janela temporal)
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(amount), 0) AS total
  FROM finance.partner_receivables pr
  WHERE pr.environment = pu.environment
    AND pr.unit_id = pu.unit_id
    AND pr.status = 'open'
    AND pr.deleted_at IS NULL
) open_recv ON true

-- Posicao futura: payables em aberto
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(amount), 0) AS total
  FROM finance.partner_payables pp3
  WHERE pp3.environment = pu.environment
    AND pp3.unit_id = pu.unit_id
    AND pp3.status = 'open'
    AND pp3.deleted_at IS NULL
) open_pay ON true

-- Estoque (legado)
LEFT JOIN LATERAL (
  SELECT count(*)::int AS stock_items,
         count(*) FILTER (WHERE stock_status IN ('low_stock', 'out_of_stock'))::int AS low_stock_items
  FROM commerce.partner_stock_levels ps
  WHERE ps.environment = pu.environment
    AND ps.unit_id = pu.unit_id
    AND ps.deleted_at IS NULL
) stock_counts ON true

WHERE pu.deleted_at IS NULL;

COMMENT ON VIEW network.partner_unit_summary IS
  'Resumo do Portal Parceiro em 3 blocos: COMPETENCIA (sales/purchases/expenses/result_competencia), CAIXA REALIZADO (cash_in/cash_out/cash_net), POSICAO FUTURA (open_receivables/open_payables/net_future). Mantem estimated_result_month como alias do result_competencia_month para compat com UI.';
