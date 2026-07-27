-- 0150 - Gate de paridade da Etapa 3: compras, vendas e estoque.
-- Funcoes somente de leitura. O backfill incremental continua no modulo admin,
-- dentro de transacao e protegido por MATRIZ_CENTRAL_LEDGER.

CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_reconciliation(
  p_environment env_t
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, finance, commerce, core, audit
AS $fn$
  SELECT jsonb_build_object(
    'purchase_accrual_missing', (
      SELECT count(*) FROM commerce.wholesale_purchases p
       WHERE p.environment=p_environment AND p.total_amount>0
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=p.environment
              AND t.source_type='commerce.wholesale_purchase.accrual'
              AND t.source_id=p.id::text
         )
    ),
    'purchase_payment_missing', (
      SELECT count(*) FROM commerce.wholesale_purchases p
       WHERE p.environment=p_environment AND p.payment_status='paid'
         AND EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=p.environment
              AND t.source_type='commerce.wholesale_purchase.accrual'
              AND t.source_id=p.id::text AND t.transaction_kind='purchase_payable'
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=p.environment
              AND t.source_type='commerce.wholesale_purchase.payment'
              AND t.source_id=p.id::text
         )
    ),
    'purchase_receipt_missing', (
      SELECT count(*) FROM commerce.wholesale_purchases p
       WHERE p.environment=p_environment AND p.stock_applied
         AND EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
           JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
            WHERE t.environment=p.environment
              AND t.source_type='commerce.wholesale_purchase.accrual'
              AND t.source_id=p.id::text AND e.account_code='inventory_in_transit'
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=p.environment
              AND t.source_type='commerce.wholesale_purchase.receipt'
              AND t.source_id=p.id::text
         )
    ),
    'purchase_cancel_missing', (
      SELECT count(*) FROM commerce.wholesale_purchases p
       WHERE p.environment=p_environment AND p.status='cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=p.environment
              AND t.source_type='commerce.wholesale_purchase.cancel'
              AND t.source_id=p.id::text
         )
    ),
    'purchase_stock_reversal_missing', (
      SELECT count(*) FROM commerce.wholesale_purchases p
       WHERE p.environment=p_environment AND p.status='cancelled' AND p.stock_applied
         AND NOT EXISTS (
           SELECT 1 FROM commerce.wholesale_stock_movements m
            WHERE m.environment=p.environment AND m.source='cancelamento_compra'
              AND m.ref=p.id::text
         )
    ),
    'wholesale_revenue_missing', (
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment AND o.total_amount>0
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.wholesale_order.revenue'
              AND t.source_id=o.id::text
         )
    ),
    'wholesale_cogs_missing', (
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment
         AND EXISTS (
           SELECT 1 FROM commerce.wholesale_order_items i
            WHERE i.environment=o.environment AND i.order_id=o.id
            GROUP BY i.order_id HAVING sum(i.quantity*i.unit_cost)>0
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.wholesale_order.cogs'
              AND t.source_id=o.id::text
         )
    ),
    'wholesale_payment_missing', (
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment AND o.payment_status='paid'
         AND EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.wholesale_order.revenue'
              AND t.source_id=o.id::text AND t.transaction_kind='sale_receivable'
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.wholesale_order.payment'
              AND t.source_id=o.id::text
         )
    ),
    'wholesale_cancel_missing', (
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment AND o.status='cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.wholesale_order.revenue_cancel'
              AND t.source_id=o.id::text
         )
    ),
    'wholesale_cogs_cancel_missing', (
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment AND o.status='cancelled'
         AND EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.wholesale_order.cogs'
              AND t.source_id=o.id::text
         )
         AND EXISTS (
           SELECT 1 FROM commerce.wholesale_stock_movements m
            WHERE m.environment=o.environment AND m.source='cancelamento_venda'
              AND m.ref=o.id::text AND m.qty_delta>0
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.wholesale_order.cogs_cancel'
              AND t.source_id=o.id::text
         )
    ),
    'wholesale_stock_return_missing', (
      SELECT count(*) FROM commerce.wholesale_orders o
       WHERE o.environment=p_environment AND o.status='cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM commerce.wholesale_stock_movements m
            WHERE m.environment=o.environment AND m.source='cancelamento_venda'
              AND m.ref=o.id::text AND m.qty_delta>0
         )
    ),
    'retail_revenue_missing', (
      SELECT count(*) FROM commerce.orders o
       JOIN core.units u
         ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
       WHERE o.environment=p_environment AND o.partner_order_id IS NULL
         AND o.total_amount>0
         AND o.status IN ('confirmed','paid','delivered','cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.order.revenue'
              AND t.source_id=o.id::text
         )
    ),
    'retail_cogs_missing', (
      SELECT count(*) FROM commerce.orders o
       JOIN core.units u
         ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
       WHERE o.environment=p_environment AND o.partner_order_id IS NULL
         AND EXISTS (
           SELECT 1 FROM audit.events a
            WHERE a.environment=o.environment AND a.entity_id=o.id
              AND a.event_type='matriz_galpao_decrement'
         )
         AND EXISTS (
           SELECT 1 FROM commerce.order_items i
            WHERE i.environment=o.environment AND i.order_id=o.id
            GROUP BY i.order_id
            HAVING COALESCE(sum(i.quantity*i.matriz_unit_cost)
              FILTER (WHERE i.matriz_unit_cost IS NOT NULL),0)>0
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.order.cogs'
              AND t.source_id=o.id::text
         )
    ),
    'retail_cancel_missing', (
      SELECT count(*) FROM commerce.orders o
       JOIN core.units u
         ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
       WHERE o.environment=p_environment AND o.partner_order_id IS NULL
         AND o.status='cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.order.revenue_cancel'
              AND t.source_id=o.id::text
         )
    ),
    'retail_payment_missing', (
      SELECT count(*) FROM commerce.orders o
      JOIN core.units u
        ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
       WHERE o.environment=p_environment AND o.partner_order_id IS NULL
         AND o.status<>'cancelled' AND o.payment_method IS NOT NULL
         AND lower(btrim(o.payment_method))<>'a receber'
         AND ((o.fulfillment_mode='delivery' AND o.delivery_status='delivered')
           OR (o.fulfillment_mode<>'delivery'
             AND o.status IN ('confirmed','paid','delivered')))
         AND EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment AND t.source_type='commerce.order.revenue'
              AND t.source_id=o.id::text AND t.transaction_kind='sale_receivable'
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment AND t.source_type='commerce.order.payment'
              AND t.source_id=o.id::text
         )
    ),
    'retail_cogs_cancel_missing', (
      SELECT count(*) FROM commerce.orders o
      JOIN core.units u
        ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
       WHERE o.environment=p_environment AND o.partner_order_id IS NULL
         AND o.status='cancelled'
         AND EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment AND t.source_type='commerce.order.cogs'
              AND t.source_id=o.id::text
         )
         AND EXISTS (
           SELECT 1 FROM audit.events a
            WHERE a.environment=o.environment AND a.entity_id=o.id
              AND a.event_type='matriz_galpao_return'
         )
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.order.cogs_cancel'
              AND t.source_id=o.id::text
         )
    ),
    'retail_stock_decrement_missing', (
      SELECT count(*) FROM commerce.orders o
       JOIN core.units u
         ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
       WHERE o.environment=p_environment AND o.partner_order_id IS NULL
         AND o.status IN ('confirmed','paid','delivered','cancelled')
         AND (
           o.status<>'cancelled'
           OR EXISTS (
             SELECT 1 FROM audit.events a
              WHERE a.environment=o.environment AND a.entity_id=o.id
                AND a.event_type='matriz_galpao_return'
           )
           OR EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=o.environment
                AND t.source_type='commerce.order.cogs'
                AND t.source_id=o.id::text
           )
           OR EXISTS (
             SELECT 1 FROM commerce.order_items i
              WHERE i.environment=o.environment AND i.order_id=o.id
                AND i.matriz_unit_cost IS NOT NULL
           )
         )
         AND EXISTS (
           SELECT 1 FROM commerce.order_items i
           JOIN commerce.tire_specs s
             ON s.environment=i.environment AND s.product_id=i.product_id
            WHERE i.environment=o.environment AND i.order_id=o.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM audit.events a
            WHERE a.environment=o.environment AND a.entity_id=o.id
              AND a.event_type='matriz_galpao_decrement'
         )
    ),
    'retail_stock_return_missing', (
      SELECT count(*) FROM commerce.orders o
       JOIN core.units u
         ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
       WHERE o.environment=p_environment AND o.partner_order_id IS NULL
         AND o.status='cancelled'
         AND EXISTS (
           SELECT 1 FROM audit.events a
            WHERE a.environment=o.environment AND a.entity_id=o.id
              AND a.event_type='matriz_galpao_decrement'
         )
         AND NOT EXISTS (
           SELECT 1 FROM audit.events a
            WHERE a.environment=o.environment AND a.entity_id=o.id
              AND a.event_type='matriz_galpao_return'
         )
    ),
    'inventory_adjustment_missing', (
      SELECT count(*) FROM finance.matriz_inventory_adjustments a
       WHERE a.environment=p_environment
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=a.environment
              AND t.source_type='finance.inventory_adjustment'
              AND t.source_id=a.id::text
         )
    )
  );
$fn$;

CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_amount_mismatches(
  p_environment env_t
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, finance, commerce, core, audit
AS $fn$
  WITH expected(source_type,source_id,amount) AS (
    SELECT 'commerce.wholesale_purchase.accrual',p.id::text,p.total_amount
      FROM commerce.wholesale_purchases p
     WHERE p.environment=p_environment AND p.total_amount>0
    UNION ALL
    SELECT 'commerce.wholesale_order.revenue',o.id::text,o.total_amount
      FROM commerce.wholesale_orders o
     WHERE o.environment=p_environment AND o.total_amount>0
    UNION ALL
    SELECT 'commerce.wholesale_order.cogs',o.id::text,
           sum(i.quantity*i.unit_cost)::numeric
      FROM commerce.wholesale_orders o
      JOIN commerce.wholesale_order_items i
        ON i.environment=o.environment AND i.order_id=o.id
     WHERE o.environment=p_environment
     GROUP BY o.id HAVING sum(i.quantity*i.unit_cost)>0
    UNION ALL
    SELECT 'commerce.order.revenue',o.id::text,o.total_amount
      FROM commerce.orders o
      JOIN core.units u
        ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
     WHERE o.environment=p_environment AND o.partner_order_id IS NULL
       AND o.total_amount>0 AND o.status IN ('confirmed','paid','delivered','cancelled')
    UNION ALL
    SELECT 'commerce.order.cogs',o.id::text,
           COALESCE(sum(i.quantity*i.matriz_unit_cost)
             FILTER (WHERE i.matriz_unit_cost IS NOT NULL),0)::numeric
      FROM commerce.orders o
      JOIN core.units u
        ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
      JOIN commerce.order_items i
        ON i.environment=o.environment AND i.order_id=o.id
     WHERE o.environment=p_environment AND o.partner_order_id IS NULL
       AND EXISTS (
         SELECT 1 FROM audit.events a
          WHERE a.environment=o.environment AND a.entity_id=o.id
            AND a.event_type='matriz_galpao_decrement'
       )
     GROUP BY o.id
    HAVING COALESCE(sum(i.quantity*i.matriz_unit_cost)
      FILTER (WHERE i.matriz_unit_cost IS NOT NULL),0)>0
    UNION ALL
    SELECT 'finance.inventory_adjustment',a.id::text,a.amount
      FROM finance.matriz_inventory_adjustments a
     WHERE a.environment=p_environment
  )
  SELECT count(*)
    FROM expected e
    JOIN finance.matriz_ledger_transactions t
      ON t.environment=p_environment
     AND t.source_type=e.source_type AND t.source_id=e.source_id
   WHERE abs(t.amount-e.amount)>0.009;
$fn$;

CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_orphans(
  p_environment env_t
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, finance, commerce
AS $fn$
  SELECT count(*)
    FROM finance.matriz_ledger_transactions t
   WHERE t.environment=p_environment
     AND (
       (t.source_type LIKE 'commerce.wholesale_purchase.%' AND NOT EXISTS (
         SELECT 1 FROM commerce.wholesale_purchases p
          WHERE p.environment=t.environment AND p.id::text=t.source_id
       ))
       OR
       (t.source_type LIKE 'commerce.wholesale_order.%' AND NOT EXISTS (
         SELECT 1 FROM commerce.wholesale_orders o
          WHERE o.environment=t.environment AND o.id::text=t.source_id
       ))
       OR
       (t.source_type LIKE 'commerce.order.%' AND NOT EXISTS (
         SELECT 1 FROM commerce.orders o
          WHERE o.environment=t.environment AND o.id::text=t.source_id
       ))
       OR
       (t.source_type='finance.inventory_adjustment' AND NOT EXISTS (
         SELECT 1 FROM finance.matriz_inventory_adjustments a
          WHERE a.environment=t.environment AND a.id::text=t.source_id
       ))
     );
$fn$;

CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_duplicates(
  p_environment env_t
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, finance
AS $fn$
  SELECT count(*) FROM (
    SELECT source_type,source_id
      FROM finance.matriz_ledger_transactions
     WHERE environment=p_environment
       AND (
         source_type LIKE 'commerce.wholesale_purchase.%'
         OR source_type LIKE 'commerce.wholesale_order.%'
         OR source_type LIKE 'commerce.order.%'
         OR source_type='finance.inventory_adjustment'
       )
     GROUP BY source_type,source_id HAVING count(*)>1
  ) duplicates;
$fn$;

REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_amount_mismatches(env_t) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_orphans(env_t) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_duplicates(env_t) FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_amount_mismatches(env_t)
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_orphans(env_t)
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_duplicates(env_t)
      FROM farejador_partner_app;
  END IF;
END
$security$;
