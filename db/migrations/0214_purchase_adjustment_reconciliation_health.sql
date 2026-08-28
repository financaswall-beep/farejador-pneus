-- 0214_purchase_adjustment_reconciliation_health.sql
-- A recusa de itens no recebimento reduz o valor corrente da compra por meio
-- de um ajuste comercial separado. A auditoria deve reconciliar o lançamento
-- original com valor corrente + ajustes, sem confundir a redução legítima com
-- corrupção do livro financeiro.

BEGIN;

CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_amount_mismatches(
  p_environment env_t
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,finance,commerce,core,audit
AS $fn$
  WITH expected(source_type,source_id,amount) AS (
    SELECT 'commerce.wholesale_purchase.accrual',p.id::text,
           p.total_amount+COALESCE((
             SELECT sum(lp.amount)
               FROM finance.matriz_ledger_transactions obligation
               JOIN finance.matriz_ledger_payments lp
                 ON lp.environment=obligation.environment
                AND lp.obligation_transaction_id=obligation.id
              WHERE obligation.environment=p.environment
                AND obligation.source_type='commerce.wholesale_purchase.accrual'
                AND obligation.source_id=p.id::text
                AND lp.payment_kind='adjustment'
           ),0)
      FROM commerce.wholesale_purchases p
     WHERE p.environment=p_environment
       AND EXISTS (
         SELECT 1 FROM finance.matriz_ledger_transactions original
          WHERE original.environment=p.environment
            AND original.source_type='commerce.wholesale_purchase.accrual'
            AND original.source_id=p.id::text
            AND original.amount>0
       )
    UNION ALL
    SELECT CASE
             WHEN o.partner_transfer_status IN ('settled','received')
              AND EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
                WHERE t.environment=o.environment AND t.source_id=o.id::text
                  AND t.source_type='commerce.wholesale_order.arrival_revenue')
               THEN 'commerce.wholesale_order.arrival_revenue'
             ELSE 'commerce.wholesale_order.revenue' END,
           o.id::text,COALESCE(o.settled_total_amount,o.total_amount)
      FROM commerce.wholesale_orders o
     WHERE o.environment=p_environment AND o.total_amount>0
       AND (o.partner_transfer_status IS NULL
         OR o.partner_transfer_status IN ('settled','received'))
    UNION ALL
    SELECT CASE
             WHEN o.partner_transfer_status IN ('settled','received')
              AND EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
                WHERE t.environment=o.environment AND t.source_id=o.id::text
                  AND t.source_type='commerce.wholesale_order.arrival_cogs')
               THEN 'commerce.wholesale_order.arrival_cogs'
             ELSE 'commerce.wholesale_order.cogs' END,
           o.id::text,
           sum((CASE WHEN o.partner_transfer_status IN ('settled','received')
             THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END)*i.unit_cost)::numeric
      FROM commerce.wholesale_orders o
      JOIN commerce.wholesale_order_items i
        ON i.environment=o.environment AND i.order_id=o.id
     WHERE o.environment=p_environment
       AND (o.partner_transfer_status IS NULL
         OR o.partner_transfer_status IN ('settled','received'))
     GROUP BY o.id HAVING sum((CASE
       WHEN o.partner_transfer_status IN ('settled','received')
         THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END)*i.unit_cost)>0
    UNION ALL
    SELECT 'commerce.wholesale_order.partner_dispatch',o.id::text,
           sum(i.quantity*i.unit_cost)::numeric
      FROM commerce.wholesale_orders o
      JOIN commerce.wholesale_order_items i
        ON i.environment=o.environment AND i.order_id=o.id
     WHERE o.environment=p_environment AND o.partner_transfer_status IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM finance.matriz_ledger_transactions legacy
          WHERE legacy.environment=o.environment AND legacy.source_id=o.id::text
            AND legacy.source_type='commerce.wholesale_order.cogs')
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
            AND a.event_type='matriz_galpao_decrement')
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

COMMENT ON FUNCTION finance.matriz_stage3_ledger_amount_mismatches(env_t) IS
  '0214: reconcilia a compra original com o total corrente somado aos ajustes comerciais por recusa no recebimento.';

REVOKE ALL ON FUNCTION
  finance.matriz_stage3_ledger_amount_mismatches(env_t) FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON FUNCTION
      finance.matriz_stage3_ledger_amount_mismatches(env_t)
      FROM farejador_partner_app;
  END IF;
END
$security$;

COMMIT;
