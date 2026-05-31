-- SNAPSHOT / ROLLBACK da network.partner_unit_summary ANTES da 0078.
-- Capturado de prod em 2026-05-31. Corpo identico a 0077 (verificado: a view viva
-- == 0077, sem override posterior). Para reverter a 0078, basta reaplicar este arquivo
-- (ou reaplicar db/migrations/0077_partner_finance_realized_delivery_dates.sql).
--
-- Diferenca unica entre este snapshot e a 0078: o calculo da lateral expenses_month.
--   ANTES (este arquivo): expenses_month = SUM(partner_expenses do mes), regime realizado.
--   DEPOIS (0078):        expenses_month = competencia (despesa direta + conta a pagar
--                         de despesa por COALESCE(due_date, paid_at, created_at)).

CREATE OR REPLACE VIEW network.partner_unit_summary
WITH (security_invoker = true) AS
 WITH month_bounds AS (
         SELECT (date_trunc('month'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text)) AT TIME ZONE 'America/Sao_Paulo'::text) AS month_start_at,
            date_trunc('month'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text))::date AS month_start_date
        )
 SELECT pu.environment,
    pu.id AS partner_unit_id,
    pu.unit_id,
    pu.slug,
    pu.display_name,
    p.id AS partner_id,
    p.trade_name AS partner_name,
    p.status AS partner_status,
    pu.status AS unit_status,
    COALESCE(orders_month.total_sales, 0::numeric) AS sales_month,
    COALESCE(orders_month.order_count, 0) AS orders_month,
    COALESCE(purchases_month.total_purchases, 0::numeric) AS purchases_month,
    COALESCE(expenses_month.total_expenses, 0::numeric) AS expenses_month,
    COALESCE(orders_month.total_sales, 0::numeric) - COALESCE(cogs_month.total, 0::numeric) - COALESCE(expenses_month.total_expenses, 0::numeric) AS result_competencia_month,
    COALESCE(orders_month.total_sales, 0::numeric) - COALESCE(cogs_month.total, 0::numeric) - COALESCE(expenses_month.total_expenses, 0::numeric) AS estimated_result_month,
    COALESCE(cash_in_month.total, 0::numeric) AS cash_in_month,
    COALESCE(cash_out_month.total, 0::numeric) AS cash_out_month,
    COALESCE(cash_in_month.total, 0::numeric) - COALESCE(cash_out_month.total, 0::numeric) AS cash_net_month,
    COALESCE(open_recv.total, 0::numeric) AS open_receivables_total,
    COALESCE(open_pay.total, 0::numeric) AS open_payables_total,
    COALESCE(open_recv.total, 0::numeric) - COALESCE(open_pay.total, 0::numeric) AS net_future_position,
    COALESCE(stock_counts.stock_items, 0) AS stock_items,
    COALESCE(stock_counts.low_stock_items, 0) AS low_stock_items,
    COALESCE(cogs_month.total, 0::numeric) AS cogs_month
   FROM network.partner_units pu
     JOIN network.partners p ON p.id = pu.partner_id AND p.environment::text = pu.environment::text
     CROSS JOIN month_bounds mb
     LEFT JOIN LATERAL (
       SELECT count(*)::integer AS order_count,
              COALESCE(sum(po.total_amount), 0::numeric) AS total_sales
       FROM commerce.partner_orders po
       WHERE po.environment::text = pu.environment::text
         AND po.unit_id = pu.unit_id
         AND po.status <> 'cancelled'::text
         AND po.deleted_at IS NULL
         AND NOT (po.fulfillment_mode = 'delivery'::text AND po.delivery_status <> 'delivered'::text)
         AND (
           CASE
             WHEN po.fulfillment_mode = 'delivery'::text THEN po.delivered_at
             ELSE po.created_at
           END
         ) >= mb.month_start_at
     ) orders_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(oi.quantity::numeric * COALESCE(ps.average_cost, 0::numeric)), 0::numeric) AS total
       FROM commerce.partner_orders po_c
         JOIN commerce.partner_order_items oi ON oi.order_id = po_c.id AND oi.environment::text = po_c.environment::text
         LEFT JOIN commerce.partner_stock_levels ps ON ps.id = oi.partner_stock_id
       WHERE po_c.environment::text = pu.environment::text
         AND po_c.unit_id = pu.unit_id
         AND po_c.status <> 'cancelled'::text
         AND po_c.deleted_at IS NULL
         AND NOT (po_c.fulfillment_mode = 'delivery'::text AND po_c.delivery_status <> 'delivered'::text)
         AND (
           CASE
             WHEN po_c.fulfillment_mode = 'delivery'::text THEN po_c.delivered_at
             ELSE po_c.created_at
           END
         ) >= mb.month_start_at
     ) cogs_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(pp.total_amount), 0::numeric) AS total_purchases
       FROM commerce.partner_purchases pp
       WHERE pp.environment::text = pu.environment::text
         AND pp.unit_id = pu.unit_id
         AND pp.purchased_at >= mb.month_start_at
         AND pp.deleted_at IS NULL
     ) purchases_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(pe.amount), 0::numeric) AS total_expenses
       FROM finance.partner_expenses pe
       WHERE pe.environment::text = pu.environment::text
         AND pe.unit_id = pu.unit_id
         AND pe.expense_date >= mb.month_start_date
         AND pe.deleted_at IS NULL
     ) expenses_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE((
                SELECT sum(po.total_amount) AS sum
                FROM commerce.partner_orders po
                WHERE po.environment::text = pu.environment::text
                  AND po.unit_id = pu.unit_id
                  AND po.status <> 'cancelled'::text
                  AND po.deleted_at IS NULL
                  AND po.created_at >= mb.month_start_at
                  AND (po.payment_method IS NULL OR po.payment_method <> 'A receber'::text)
              ), 0::numeric)
              + COALESCE((
                SELECT sum(pre.amount) AS sum
                FROM finance.partner_receivables_effective pre
                WHERE pre.environment::text = pu.environment::text
                  AND pre.unit_id = pu.unit_id
                  AND pre.status = 'received'::text
                  AND pre.received_at >= mb.month_start_at
              ), 0::numeric) AS total
     ) cash_in_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE((
                SELECT sum(pp.total_amount) AS sum
                FROM commerce.partner_purchases pp
                WHERE pp.environment::text = pu.environment::text
                  AND pp.unit_id = pu.unit_id
                  AND pp.deleted_at IS NULL
                  AND pp.purchased_at >= mb.month_start_at
                  AND pp.payment_status = 'paid_now'::text
              ), 0::numeric)
              + COALESCE((
                SELECT sum(pe.amount) AS sum
                FROM finance.partner_expenses pe
                WHERE pe.environment::text = pu.environment::text
                  AND pe.unit_id = pu.unit_id
                  AND pe.deleted_at IS NULL
                  AND pe.expense_date >= mb.month_start_date
                  AND pe.source_payable_id IS NULL
              ), 0::numeric)
              + COALESCE((
                SELECT sum(pp2.amount) AS sum
                FROM finance.partner_payables pp2
                WHERE pp2.environment::text = pu.environment::text
                  AND pp2.unit_id = pu.unit_id
                  AND pp2.deleted_at IS NULL
                  AND pp2.status = 'paid'::text
                  AND pp2.paid_at >= mb.month_start_at
              ), 0::numeric) AS total
     ) cash_out_month ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(pre.amount), 0::numeric) AS total
       FROM finance.partner_receivables_effective pre
       WHERE pre.environment::text = pu.environment::text
         AND pre.unit_id = pu.unit_id
         AND pre.status = 'open'::text
     ) open_recv ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(pp3.amount), 0::numeric) AS total
       FROM finance.partner_payables pp3
       WHERE pp3.environment::text = pu.environment::text
         AND pp3.unit_id = pu.unit_id
         AND pp3.status = 'open'::text
         AND pp3.deleted_at IS NULL
     ) open_pay ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::integer AS stock_items,
              count(*) FILTER (WHERE ps.stock_status = ANY (ARRAY['low_stock'::text, 'out_of_stock'::text]))::integer AS low_stock_items
       FROM commerce.partner_stock_levels ps
       WHERE ps.environment::text = pu.environment::text
         AND ps.unit_id = pu.unit_id
         AND ps.deleted_at IS NULL
     ) stock_counts ON true
  WHERE pu.deleted_at IS NULL;

COMMENT ON VIEW network.partner_unit_summary IS
  'Resumo mensal por unidade parceira. 0077: delivery/COD entra em sales_month/orders_month/cogs_month pela data de entrega (delivered_at); pedido aberto segue apenas como reserva/a receber.';

GRANT SELECT ON network.partner_unit_summary TO farejador_partner_app;
