-- 0036_partner_expense_soft_delete.sql
-- Adiciona exclusao logica de despesas do Portal Parceiro.
-- Mantem isolamento por environment + unit_id e nao toca em bot/shadow.

ALTER TABLE finance.partner_expenses
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

CREATE INDEX IF NOT EXISTS partner_expenses_unit_active_date_idx
  ON finance.partner_expenses(environment, unit_id, expense_date DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE VIEW network.partner_unit_summary AS
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
  COALESCE(orders_month.total_sales, 0) AS sales_month,
  COALESCE(orders_month.order_count, 0) AS orders_month,
  COALESCE(purchases_month.total_purchases, 0) AS purchases_month,
  COALESCE(expenses_month.total_expenses, 0) AS expenses_month,
  COALESCE(stock_counts.stock_items, 0) AS stock_items,
  COALESCE(stock_counts.low_stock_items, 0) AS low_stock_items,
  COALESCE(orders_month.total_sales, 0)
    - COALESCE(purchases_month.total_purchases, 0)
    - COALESCE(expenses_month.total_expenses, 0) AS estimated_result_month
FROM network.partner_units pu
JOIN network.partners p
  ON p.id = pu.partner_id AND p.environment = pu.environment
LEFT JOIN LATERAL (
  SELECT count(*)::int AS order_count, COALESCE(sum(total_amount), 0) AS total_sales
  FROM commerce.orders o
  WHERE o.environment = pu.environment
    AND o.unit_id = pu.unit_id
    AND o.status <> 'cancelled'
    AND o.created_at >= date_trunc('month', now())
) orders_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(total_amount), 0) AS total_purchases
  FROM commerce.partner_purchases pp
  WHERE pp.environment = pu.environment
    AND pp.unit_id = pu.unit_id
    AND pp.purchased_at >= date_trunc('month', now())
) purchases_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(amount), 0) AS total_expenses
  FROM finance.partner_expenses pe
  WHERE pe.environment = pu.environment
    AND pe.unit_id = pu.unit_id
    AND pe.expense_date >= date_trunc('month', now())::date
    AND pe.deleted_at IS NULL
) expenses_month ON true
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
  'Resumo seguro do portal parceiro. Uma linha por unidade, sem dados de bot/shadow. Despesas excluidas logicamente nao entram no total.';
