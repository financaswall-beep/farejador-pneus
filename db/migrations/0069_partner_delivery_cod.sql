-- ============================================================
-- 0069_partner_delivery_cod.sql
-- Pedido da internet com pagamento na entrega (COD).
--
-- Contexto (Wallace, 2026-05-29):
--   Pneu usado vendido pela internet so e pago na ENTREGA (cash on delivery).
--   O pedido nasce "pendente": reserva estoque (decremento ja existente),
--   NAO conta como venda nem como caixa. So quando o entregador marca
--   FINALIZADA a venda se realiza (entra no caixa, vira venda do mes).
--   Se a entrega falhar (cliente fora, recusa), o pedido e cancelado e o
--   estoque volta.
--
-- Modelo reaproveitado (sem tabela nova de "reservado"):
--   - Pedido COD = pedido com payment_method='A receber' + conta a receber
--     aberta (finance.partner_receivables.source_order_id aponta pro pedido).
--   - register_partner_local_order ja decrementa estoque (= reserva).
--   - Finalizar entrega: recebe a conta a receber (entra no caixa) + status='paid'.
--   - Nao entregue: cancel_partner_local_order (devolve estoque) + cancela a receber.
--   - O pedido fica com payment_method='A receber' SEMPRE (mesmo finalizado),
--     pra o caixa vir so da conta a receber e nao duplicar.
--
-- O que esta migration faz:
--   1. Adiciona o estado 'failed' (nao entregue / devolvido) ao CHECK de
--      commerce.partner_orders.delivery_status.
--   2. Recria network.partner_unit_summary pra EXCLUIR pedidos de entrega
--      nao-finalizados de sales_month / orders_month (so contam quando
--      delivery_status='delivered'). Pickup e entrega finalizada contam normal.
--
-- Aditiva: nao altera dado existente. Pedidos pickup antigos nao tem
-- delivery_status='delivered' explicito? Tem — default e 'pending', MAS o
-- filtro so exclui quando fulfillment_mode='delivery'. Pickup nunca e excluido.
--
-- Assinatura: Claude (Opus 4.8), 2026-05-29
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. Estado 'failed' no delivery_status
-- ─────────────────────────────────────────────
ALTER TABLE commerce.partner_orders
  DROP CONSTRAINT IF EXISTS partner_orders_delivery_status_check;

ALTER TABLE commerce.partner_orders
  ADD CONSTRAINT partner_orders_delivery_status_check
  CHECK (delivery_status IN ('pending', 'dispatched', 'delivered', 'failed'));

COMMENT ON COLUMN commerce.partner_orders.delivery_status IS
  'Estado operacional da entrega (so relevante quando fulfillment_mode=delivery): '
  'pending | dispatched (saiu) | delivered (finalizada) | failed (nao entregue/devolvido).';

-- ─────────────────────────────────────────────
-- 2. partner_unit_summary: pedido de entrega so vira "venda"/caixa ao finalizar
--    (unica mudanca vs 0058+: predicado em orders_month exclui entrega nao-delivered)
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW network.partner_unit_summary AS
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
    COALESCE(orders_month.total_sales, 0::numeric) - COALESCE(purchases_month.total_purchases, 0::numeric) - COALESCE(expenses_month.total_expenses, 0::numeric) AS result_competencia_month,
    COALESCE(orders_month.total_sales, 0::numeric) - COALESCE(purchases_month.total_purchases, 0::numeric) - COALESCE(expenses_month.total_expenses, 0::numeric) AS estimated_result_month,
    COALESCE(cash_in_month.total, 0::numeric) AS cash_in_month,
    COALESCE(cash_out_month.total, 0::numeric) AS cash_out_month,
    COALESCE(cash_in_month.total, 0::numeric) - COALESCE(cash_out_month.total, 0::numeric) AS cash_net_month,
    COALESCE(open_recv.total, 0::numeric) AS open_receivables_total,
    COALESCE(open_pay.total, 0::numeric) AS open_payables_total,
    COALESCE(open_recv.total, 0::numeric) - COALESCE(open_pay.total, 0::numeric) AS net_future_position,
    COALESCE(stock_counts.stock_items, 0) AS stock_items,
    COALESCE(stock_counts.low_stock_items, 0) AS low_stock_items
   FROM network.partner_units pu
     JOIN network.partners p ON p.id = pu.partner_id AND p.environment::text = pu.environment::text
     CROSS JOIN month_bounds mb
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS order_count,
            COALESCE(sum(po.total_amount), 0::numeric) AS total_sales
           FROM commerce.partner_orders po
          WHERE po.environment::text = pu.environment::text AND po.unit_id = pu.unit_id AND po.status <> 'cancelled'::text AND po.deleted_at IS NULL AND po.created_at >= mb.month_start_at
            -- COD: pedido de entrega so conta como venda quando finalizado (entregue)
            AND NOT (po.fulfillment_mode = 'delivery'::text AND po.delivery_status <> 'delivered'::text)) orders_month ON true
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(pp.total_amount), 0::numeric) AS total_purchases
           FROM commerce.partner_purchases pp
          WHERE pp.environment::text = pu.environment::text AND pp.unit_id = pu.unit_id AND pp.purchased_at >= mb.month_start_at AND pp.deleted_at IS NULL) purchases_month ON true
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(pe.amount), 0::numeric) AS total_expenses
           FROM finance.partner_expenses pe
          WHERE pe.environment::text = pu.environment::text AND pe.unit_id = pu.unit_id AND pe.expense_date >= mb.month_start_date AND pe.deleted_at IS NULL) expenses_month ON true
     LEFT JOIN LATERAL ( SELECT COALESCE(( SELECT sum(po.total_amount) AS sum
                   FROM commerce.partner_orders po
                  WHERE po.environment::text = pu.environment::text AND po.unit_id = pu.unit_id AND po.status <> 'cancelled'::text AND po.deleted_at IS NULL AND po.created_at >= mb.month_start_at AND (po.payment_method IS NULL OR po.payment_method <> 'A receber'::text)), 0::numeric) + COALESCE(( SELECT sum(pre.amount) AS sum
                   FROM finance.partner_receivables_effective pre
                  WHERE pre.environment::text = pu.environment::text AND pre.unit_id = pu.unit_id AND pre.status = 'received'::text AND pre.received_at >= mb.month_start_at), 0::numeric) AS total) cash_in_month ON true
     LEFT JOIN LATERAL ( SELECT COALESCE(( SELECT sum(pp.total_amount) AS sum
                   FROM commerce.partner_purchases pp
                  WHERE pp.environment::text = pu.environment::text AND pp.unit_id = pu.unit_id AND pp.deleted_at IS NULL AND pp.purchased_at >= mb.month_start_at AND pp.payment_status = 'paid_now'::text), 0::numeric) + COALESCE(( SELECT sum(pe.amount) AS sum
                   FROM finance.partner_expenses pe
                  WHERE pe.environment::text = pu.environment::text AND pe.unit_id = pu.unit_id AND pe.deleted_at IS NULL AND pe.expense_date >= mb.month_start_date AND pe.source_payable_id IS NULL), 0::numeric) + COALESCE(( SELECT sum(pp2.amount) AS sum
                   FROM finance.partner_payables pp2
                  WHERE pp2.environment::text = pu.environment::text AND pp2.unit_id = pu.unit_id AND pp2.deleted_at IS NULL AND pp2.status = 'paid'::text AND pp2.paid_at >= mb.month_start_at), 0::numeric) AS total) cash_out_month ON true
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(pre.amount), 0::numeric) AS total
           FROM finance.partner_receivables_effective pre
          WHERE pre.environment::text = pu.environment::text AND pre.unit_id = pu.unit_id AND pre.status = 'open'::text) open_recv ON true
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(pp3.amount), 0::numeric) AS total
           FROM finance.partner_payables pp3
          WHERE pp3.environment::text = pu.environment::text AND pp3.unit_id = pu.unit_id AND pp3.status = 'open'::text AND pp3.deleted_at IS NULL) open_pay ON true
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS stock_items,
            count(*) FILTER (WHERE ps.stock_status = ANY (ARRAY['low_stock'::text, 'out_of_stock'::text]))::integer AS low_stock_items
           FROM commerce.partner_stock_levels ps
          WHERE ps.environment::text = pu.environment::text AND ps.unit_id = pu.unit_id AND ps.deleted_at IS NULL) stock_counts ON true
  WHERE pu.deleted_at IS NULL;

COMMENT ON VIEW network.partner_unit_summary IS
  'Resumo mensal por unidade parceira. COD (0069): pedido de entrega so entra em sales_month/orders_month quando delivery_status=delivered; ate la fica so como conta a receber.';
