/** Shared monthly financial reconciliation, including Meta and Google origins. */
export const MATRIZ_LEDGER_FINANCIAL_SQL = `WITH bounds AS (
       SELECT COALESCE(to_date($3,'YYYY-MM'),
                date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date) month_start,
              (COALESCE(to_date($3,'YYYY-MM'),
                date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date)
                +interval '1 month')::date month_end,
              (COALESCE(to_date($3,'YYYY-MM'),
                date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp
                AT TIME ZONE 'America/Sao_Paulo') month_ts,
              ((COALESCE(to_date($3,'YYYY-MM'),
                date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date)
                +interval '1 month')::timestamp AT TIME ZONE 'America/Sao_Paulo') month_end_ts
     ), ledger AS (
       SELECT t.id,t.source_type,t.source_id,t.competence_on,t.cash_on,
              e.account_code,e.account_class,e.side,e.amount
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment=$1
     ), month_ledger AS (
       SELECT l.* FROM ledger l,bounds b
        WHERE l.competence_on>=b.month_start AND l.competence_on<b.month_end
     ), cash_month AS (
       SELECT l.* FROM ledger l,bounds b
        WHERE l.cash_on>=b.month_start AND l.cash_on<b.month_end
     ), retail AS (
       SELECT o.id,o.total_amount,o.created_at,o.updated_at,o.status,
              o.fulfillment_mode,o.closed_by,
              realization.recognized_at,realization.cancelled_at,realization.was_realized,
              COALESCE(sum(i.quantity*i.unit_price-i.discount_amount),0) item_total,
              COALESCE(sum(i.quantity*i.unit_price-i.discount_amount)
                FILTER (WHERE i.matriz_unit_cost IS NULL),0) pending_revenue,
              count(*) FILTER (WHERE i.matriz_unit_cost IS NULL)::int pending_items
         FROM commerce.orders o
         JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id
          AND u.slug='main'
         JOIN finance.v_matriz_retail_realization realization
           ON realization.environment=o.environment AND realization.order_id=o.id
         JOIN commerce.order_items i
           ON i.environment=o.environment AND i.order_id=o.id
        WHERE o.environment=$1 AND o.partner_order_id IS NULL
        GROUP BY o.id,realization.recognized_at,realization.cancelled_at,realization.was_realized
     )
     SELECT
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='revenue'
           AND account_code<>'inventory_gain'),0) revenue,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_code='cost_of_goods_sold'),0) known_cost,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='expense'
           AND account_code NOT IN (
             'cost_of_goods_sold','inventory_loss','inventory_internal_use')),0)
         operating_expenses,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_code='inventory_gain'),0) inventory_gain,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM month_ledger
        WHERE account_code IN ('inventory_loss','inventory_internal_use')),0) inventory_loss,
       COALESCE((SELECT sum(amount) FROM cash_month
         WHERE account_code='cash' AND side='debit'),0) cash_in,
       COALESCE((SELECT sum(amount) FROM cash_month
         WHERE account_code='cash' AND side='credit'),0) cash_out,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM ledger,bounds b WHERE account_code='cash' AND cash_on<b.month_start),0)
         cash_opening,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'commerce.order.%'),0) cash_retail,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'commerce.wholesale_order.%'),0) cash_wholesale,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'network.commission_entry.%'),0) cash_network,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'network.monthly_fee.%'),0) cash_monthly,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'commerce.wholesale_purchase.%'),0) cash_purchases,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'commerce.matriz_expense.%'),0) cash_expenses,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type='network.commission_refund.payment'),0)
         cash_commission_refund,
       COALESCE((SELECT sum(pending_revenue) FROM retail,bounds b
         WHERE status<>'cancelled' AND was_realized
           AND recognized_at>=b.month_ts AND recognized_at<b.month_end_ts),0) pending_revenue,
       COALESCE((SELECT sum(pending_items) FROM retail,bounds b
         WHERE status<>'cancelled' AND was_realized
           AND recognized_at>=b.month_ts AND recognized_at<b.month_end_ts),0)::int pending_items,
       (SELECT count(*)::int FROM retail,bounds b
         WHERE status<>'cancelled' AND was_realized AND pending_items>0
           AND recognized_at>=b.month_ts AND recognized_at<b.month_end_ts) pending_orders,
       COALESCE((SELECT sum(CASE
         WHEN account_class='asset' AND account_code LIKE '%receivable%'
           THEN CASE side WHEN 'debit' THEN amount ELSE -amount END ELSE 0 END)
         FROM ledger),0) receivables,
       COALESCE((SELECT sum(CASE
         WHEN account_class='liability' AND (
           account_code LIKE '%payable%' OR account_code='accounts_payable')
           THEN CASE side WHEN 'credit' THEN amount ELSE -amount END ELSE 0 END)
         FROM ledger),0) payables,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM ledger WHERE account_code='accounts_receivable'
           AND source_type LIKE 'commerce.order.%'),0) retail_receivable,
       (SELECT count(*)::int FROM retail WHERE status='cancelled') cancelled_retail,
       (SELECT count(*)::int FROM commerce.wholesale_orders
         WHERE environment=$1 AND status='cancelled') cancelled_wholesale,
       (SELECT count(*)::int FROM commerce.wholesale_purchases
         WHERE environment=$1 AND status='cancelled') cancelled_purchases,
       (SELECT count(*)::int FROM network.commission_entries
         WHERE environment=$1 AND status='reversed') reversed_commissions,
       (SELECT count(*)::int FROM commerce.matriz_expenses
         WHERE environment=$1 AND deleted_at IS NOT NULL) deleted_expenses,
       (SELECT count(*)::int FROM finance.matriz_commission_reversals
         WHERE environment=$1 AND refund_status='pending') reversed_after_settlement,
       ((SELECT count(*) FROM retail
          WHERE lower(COALESCE(closed_by,''))~'(test|teste|prova|demo)')
        +(SELECT count(*) FROM finance.matriz_ledger_transactions
          WHERE environment=$1
            AND lower(created_by||' '||description)~'(test|teste|prova|demo)'))::int
         suspected_test_rows,
       COALESCE((SELECT sum(COALESCE(o.settled_total_amount,o.total_amount)) FROM commerce.wholesale_orders o,bounds b
         WHERE o.environment=$1
           AND (CASE WHEN o.partner_transfer_status IN ('settled','received') THEN
             COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END)>=b.month_ts
           AND (CASE WHEN o.partner_transfer_status IN ('settled','received') THEN
             COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END)<b.month_end_ts
           AND (o.partner_transfer_status IS NULL
             OR o.partner_transfer_status IN ('settled','received'))),0)
       -COALESCE((SELECT sum(COALESCE(o.settled_total_amount,o.total_amount)) FROM commerce.wholesale_orders o,bounds b
         WHERE o.environment=$1 AND o.status='cancelled'
           AND o.cancelled_at>=b.month_ts AND o.cancelled_at<b.month_end_ts),0)
         source_wholesale,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='revenue'
           AND source_type LIKE 'commerce.wholesale_order.%'),0) ledger_wholesale,
       COALESCE((SELECT sum(total_amount) FROM retail,bounds b
         WHERE was_realized
           AND recognized_at>=b.month_ts AND recognized_at<b.month_end_ts),0)
       -COALESCE((SELECT sum(total_amount) FROM retail,bounds b
         WHERE status='cancelled' AND was_realized AND cancelled_at>=b.month_ts
           AND cancelled_at<b.month_end_ts),0) source_retail,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='revenue'
           AND source_type LIKE 'commerce.order.%'),0) ledger_retail,
       COALESCE((SELECT sum(GREATEST(total_amount-item_total,0))
         FROM retail,bounds b WHERE fulfillment_mode='delivery'
           AND status IN ('confirmed','paid','delivered') AND recognized_at>=b.month_ts
           AND recognized_at<b.month_end_ts),0) source_freight,
       COALESCE((SELECT sum(commission_amount) FROM network.commission_entries,bounds b
         WHERE environment=$1 AND realized_at>=b.month_ts
           AND realized_at<b.month_end_ts),0)
       -COALESCE((SELECT sum(amount) FROM finance.matriz_commission_reversals,bounds b
         WHERE environment=$1 AND reversed_at>=b.month_ts
           AND reversed_at<b.month_end_ts),0) source_commission,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='revenue'
           AND source_type LIKE 'network.commission_entry.%'),0) ledger_commission,
       COALESCE((SELECT sum(amount) FROM finance.matriz_partner_monthly_fees,bounds b
         WHERE environment=$1 AND competence>=b.month_start
           AND competence<b.month_end),0) source_monthly,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='revenue'
           AND source_type LIKE 'network.monthly_fee.%'),0) ledger_monthly,
       COALESCE((SELECT sum(amount) FROM commerce.matriz_expenses,bounds b
         WHERE environment=$1
           AND ops.matriz_expense_competence_month(competence_month,occurred_at)
             >=b.month_start
           AND ops.matriz_expense_competence_month(competence_month,occurred_at)
             <b.month_end),0)
       -COALESCE((SELECT sum(amount) FROM commerce.matriz_expenses,bounds b
         WHERE environment=$1 AND deleted_at IS NOT NULL
           AND (deleted_at AT TIME ZONE 'America/Sao_Paulo')::date>=b.month_start
           AND (deleted_at AT TIME ZONE 'America/Sao_Paulo')::date<b.month_end),0)
         source_expenses,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='expense'
           AND account_code LIKE 'expense_%'),0) ledger_expenses,
       COALESCE((SELECT sum(CASE WHEN $2::boolean THEN scoped_spend ELSE expected_spend END) FROM
         marketing.meta_spend_expected,bounds b
         WHERE environment=$1
           AND metric_date>=b.month_start AND metric_date<b.month_end),0)
       +COALESCE((SELECT sum(expected_spend) FROM marketing.google_spend_expected,bounds b
         WHERE environment=$1 AND metric_date>=b.month_start AND metric_date<b.month_end),0)
         source_marketing,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_code='marketing_expense'),0) ledger_marketing,
       COALESCE((SELECT sum(total_amount) FROM commerce.wholesale_purchases p,bounds b
         WHERE p.environment=$1 AND p.purchased_at>=b.month_ts
           AND p.purchased_at<b.month_end_ts),0)
       -COALESCE((SELECT sum(total_amount) FROM commerce.wholesale_purchases p,bounds b
         WHERE p.environment=$1 AND p.status='cancelled'
           AND p.cancelled_at>=b.month_ts
           AND p.cancelled_at<b.month_end_ts),0) source_purchases,
       COALESCE((SELECT sum(CASE
         WHEN account_code IN ('inventory','inventory_in_transit')
           THEN CASE side WHEN 'debit' THEN amount ELSE -amount END ELSE 0 END)
         FROM month_ledger WHERE source_type LIKE 'commerce.wholesale_purchase.%'),0)
         ledger_purchases,
       COALESCE((SELECT sum(CASE direction WHEN 'gain' THEN amount ELSE -amount END)
         FROM finance.matriz_inventory_adjustments,bounds b
         WHERE environment=$1 AND occurred_at>=b.month_ts
           AND occurred_at<b.month_end_ts),0) source_inventory,
       COALESCE((SELECT sum(CASE
         WHEN account_code='inventory_gain'
           THEN CASE side WHEN 'credit' THEN amount ELSE -amount END
         WHEN account_code IN ('inventory_loss','inventory_internal_use')
           THEN CASE side WHEN 'credit' THEN amount ELSE -amount END
         ELSE 0 END) FROM month_ledger),0) ledger_inventory`;
