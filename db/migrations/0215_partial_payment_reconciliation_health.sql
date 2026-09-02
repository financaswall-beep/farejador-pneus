-- 0215_partial_payment_reconciliation_health.sql
-- Pagamentos parciais usam um source_id idempotente próprio. O identificador
-- da compra ou venda original fica preservado em metadata.source_id e deve ser
-- usado pela reconciliação para verificar se a origem operacional existe.

BEGIN;

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
          WHERE p.environment=t.environment
            AND p.id::text=CASE
              WHEN t.source_type='commerce.wholesale_purchase.partial_payment'
                THEN t.metadata->>'source_id'
              ELSE t.source_id
            END
       ))
       OR
       (t.source_type LIKE 'commerce.wholesale_order.%' AND NOT EXISTS (
         SELECT 1 FROM commerce.wholesale_orders o
          WHERE o.environment=t.environment
            AND o.id::text=CASE
              WHEN t.source_type='commerce.wholesale_order.partial_payment'
                THEN t.metadata->>'source_id'
              ELSE t.source_id
            END
       ))
       OR
       (t.source_type LIKE 'commerce.order.%' AND NOT EXISTS (
         SELECT 1 FROM commerce.orders o
          WHERE o.environment=t.environment
            AND o.id::text=CASE
              WHEN t.source_type='commerce.order.partial_payment'
                THEN t.metadata->>'source_id'
              ELSE t.source_id
            END
       ))
       OR
       (t.source_type='finance.inventory_adjustment' AND NOT EXISTS (
         SELECT 1 FROM finance.matriz_inventory_adjustments a
          WHERE a.environment=t.environment AND a.id::text=t.source_id
       ))
     );
$fn$;

COMMENT ON FUNCTION finance.matriz_stage3_ledger_orphans(env_t) IS
  '0215: valida pagamentos parciais pela origem operacional preservada em metadata.source_id.';

REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_orphans(env_t) FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_orphans(env_t)
      FROM farejador_partner_app;
  END IF;
END
$security$;

COMMIT;
