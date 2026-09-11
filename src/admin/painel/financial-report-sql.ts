// Only account entries determine values. Transaction headers can contain several accounting legs.
export const financialMovementsSql=`SELECT t.id,t.source_type,
  COALESCE(b.source_id,o.source_id,t.metadata->>'source_id',t.source_id) AS source_id,t.description,
  COALESCE(ro.order_number,CASE WHEN wo.id IS NOT NULL THEN 'ATA-'||upper(right(replace(wo.id::text,'-',''),8)) END,
    CASE WHEN wp.id IS NOT NULL THEN 'CMP-'||upper(right(replace(wp.id::text,'-',''),8)) END) AS reference,
  COALESCE(wc.name,rc.name,ct.name,ws.name,np.trade_name,np.legal_name) AS party,
  t.competence_on::text,t.cash_on::text,
  COALESCE(t.metadata->>'category',b.metadata->>'category',o.metadata->>'category') AS category,
  t.metadata->>'payment_method' AS payment_method,t.metadata->>'cash_account' AS cash_account,
  t.reversal_of_transaction_id AS reversal_of,
  EXISTS(SELECT 1 FROM finance.matriz_ledger_transactions r WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id) AS reversed,
  COALESCE(sum(CASE e.side WHEN 'credit' THEN e.amount ELSE -e.amount END) FILTER(WHERE e.account_class='revenue' AND e.account_code<>'inventory_gain'),0)::float8 AS revenue,
  COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END) FILTER(WHERE e.account_code='cost_of_goods_sold'),0)::float8 AS cost,
  COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END) FILTER(WHERE e.account_class='expense' AND e.account_code NOT IN ('cost_of_goods_sold','inventory_loss','inventory_internal_use')),0)::float8 AS expense,
  COALESCE(sum(CASE e.side WHEN 'credit' THEN e.amount ELSE -e.amount END) FILTER(WHERE e.account_code='inventory_gain'),0)::float8 AS gain,
  COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END) FILTER(WHERE e.account_code IN ('inventory_loss','inventory_internal_use')),0)::float8 AS loss,
  COALESCE(sum(e.amount) FILTER(WHERE e.account_code='cash' AND e.side='debit'),0)::float8 AS cash_in,
  COALESCE(sum(e.amount) FILTER(WHERE e.account_code='cash' AND e.side='credit'),0)::float8 AS cash_out
  FROM finance.matriz_ledger_transactions t
  JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id AND e.environment=t.environment
  LEFT JOIN LATERAL(SELECT base.source_id,base.metadata FROM finance.matriz_ledger_payments p
    JOIN finance.matriz_ledger_transactions base ON base.id=p.obligation_transaction_id AND base.environment=p.environment
    WHERE p.environment=t.environment AND p.payment_transaction_id=t.id ORDER BY p.id LIMIT 1) b ON true
  LEFT JOIN finance.matriz_ledger_transactions o ON o.id=t.reversal_of_transaction_id AND o.environment=t.environment
  LEFT JOIN commerce.wholesale_orders wo ON wo.environment=t.environment AND t.source_type LIKE 'commerce.wholesale_order.%'
    AND wo.id::text=COALESCE(b.source_id,o.source_id,t.metadata->>'order_id',t.metadata->>'source_id',t.source_id)
  LEFT JOIN commerce.wholesale_customers wc ON wc.environment=wo.environment AND wc.id=wo.buyer_id
  LEFT JOIN commerce.orders ro ON ro.environment=t.environment AND t.source_type LIKE 'commerce.order.%'
    AND ro.id::text=COALESCE(b.source_id,o.source_id,t.metadata->>'order_id',t.metadata->>'source_id',t.source_id)
  LEFT JOIN commerce.customers rc ON rc.environment=ro.environment AND rc.id=ro.customer_id
  LEFT JOIN core.contacts ct ON ct.environment=ro.environment AND ct.id=ro.contact_id
  LEFT JOIN commerce.wholesale_purchases wp ON wp.environment=t.environment AND t.source_type LIKE 'commerce.wholesale_purchase.%'
    AND wp.id::text=COALESCE(b.source_id,o.source_id,t.metadata->>'purchase_id',t.metadata->>'source_id',t.source_id)
  LEFT JOIN commerce.wholesale_suppliers ws ON ws.environment=wp.environment AND ws.id=wp.supplier_id
  LEFT JOIN network.partners np ON np.environment=t.environment AND np.id::text=COALESCE(t.metadata->>'partner_id',b.metadata->>'partner_id',o.metadata->>'partner_id')
  WHERE t.environment=$1 AND (t.competence_on BETWEEN $2::date AND $3::date OR t.cash_on BETWEEN $2::date AND $3::date)
  GROUP BY t.id,b.source_id,b.metadata,o.source_id,o.metadata,wo.id,ro.order_number,wp.id,wc.name,rc.name,ct.name,ws.name,np.trade_name,np.legal_name
  ORDER BY t.competence_on DESC,t.id DESC LIMIT 20001`;

export const financialOpeningSql=`SELECT t.source_type,
  COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END),0)::float8 AS amount
  FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id AND e.environment=t.environment
  WHERE t.environment=$1 AND e.account_code='cash' AND t.cash_on<$2::date GROUP BY t.source_type`;

export const financialPendingCostSql=`SELECT (CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at ELSE o.created_at END
  AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,
  COALESCE(sum(i.quantity*i.unit_price-i.discount_amount),0)::float8 AS amount,count(*)::int AS items
  FROM commerce.orders o JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
  JOIN commerce.order_items i ON i.order_id=o.id AND i.environment=o.environment
  WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.status IN ('confirmed','paid','delivered') AND i.matriz_unit_cost IS NULL
    AND (CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at ELSE o.created_at END AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
  GROUP BY 1 ORDER BY 1`;
