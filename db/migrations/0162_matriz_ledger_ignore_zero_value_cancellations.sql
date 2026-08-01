-- 0162 - Cancelamentos sem valor financeiro nao exigem estorno no livro central.
--
-- O backfill da Etapa 3 ignora fontes com total_amount=0, mas a funcao de
-- reconciliacao 0150 ainda as contava como estorno ausente. Isso criava um
-- estado vermelho impossivel de reparar e bloqueava a leitura do Financeiro.

ALTER FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
  RENAME TO matriz_stage3_ledger_reconciliation_v0150;

CREATE FUNCTION finance.matriz_stage3_ledger_reconciliation(
  p_environment env_t
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, finance, commerce, core, audit
AS $fn$
  SELECT finance.matriz_stage3_ledger_reconciliation_v0150(p_environment)
    || jsonb_build_object(
      'purchase_cancel_missing', (
        SELECT count(*) FROM commerce.wholesale_purchases p
         WHERE p.environment=p_environment AND p.status='cancelled'
           AND p.total_amount>0
           AND NOT EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=p.environment
                AND t.source_type='commerce.wholesale_purchase.cancel'
                AND t.source_id=p.id::text
           )
      ),
      'wholesale_cancel_missing', (
        SELECT count(*) FROM commerce.wholesale_orders o
         WHERE o.environment=p_environment AND o.status='cancelled'
           AND o.total_amount>0
           AND NOT EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=o.environment
                AND t.source_type='commerce.wholesale_order.revenue_cancel'
                AND t.source_id=o.id::text
           )
      ),
      'retail_cancel_missing', (
        SELECT count(*) FROM commerce.orders o
         JOIN core.units u
           ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
         WHERE o.environment=p_environment AND o.partner_order_id IS NULL
           AND o.status='cancelled' AND o.total_amount>0
           AND NOT EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=o.environment
                AND t.source_type='commerce.order.revenue_cancel'
                AND t.source_id=o.id::text
           )
      )
    );
$fn$;

COMMENT ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t) IS
  'Gate Etapa 3; cancelamentos de valor zero nao exigem lancamento financeiro.';

REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
  FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
      FROM farejador_partner_app;
  END IF;
END
$security$;
