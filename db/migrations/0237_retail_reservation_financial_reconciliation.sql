-- Reserva com custo congelado não comprova venda. A realização exige estado
-- operacional concluído ou evidência histórica de realização, nunca só custo.
BEGIN;

CREATE OR REPLACE VIEW finance.v_matriz_retail_realization
WITH (security_invoker=true) AS
SELECT o.environment,o.id order_id,
  CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at
    ELSE COALESCE(o.retrieved_at,o.created_at) END recognized_at,
  COALESCE((SELECT min(a.created_at) FROM audit.events a
    WHERE a.environment=o.environment AND a.entity_id=o.id
      AND a.event_type='manual_order_cancelled'),o.updated_at) cancelled_at,
  (
    (o.status IN ('confirmed','paid','delivered')
      AND (o.fulfillment_mode<>'delivery' OR o.delivery_status='delivered'))
    OR (o.status='cancelled' AND (
      o.retrieved_at IS NOT NULL OR o.delivered_at IS NOT NULL
      OR (o.fulfillment_mode<>'delivery' AND EXISTS (SELECT 1 FROM audit.events a
        WHERE a.environment=o.environment AND a.entity_id=o.id
          AND a.event_type IN ('matriz_galpao_decrement','matriz_galpao_return')))
      OR EXISTS (SELECT 1 FROM audit.events a
        WHERE a.environment=o.environment AND a.entity_id=o.id
          AND a.event_type='manual_order_cancelled'
          AND ((o.fulfillment_mode<>'delivery'
            AND a.payload_before->>'status' IN ('confirmed','paid','delivered'))
            OR a.payload_before->>'status'='delivered'))
      OR EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
        WHERE t.environment=o.environment AND t.source_id=o.id::text
          AND t.source_type IN ('commerce.order.revenue','commerce.order.cogs'))
    ))
  ) was_realized
FROM commerce.orders o
JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
WHERE o.partner_order_id IS NULL;

REVOKE ALL ON finance.v_matriz_retail_realization FROM PUBLIC,farejador_partner_app;

DO $rename$
BEGIN
  IF to_regprocedure('finance.matriz_stage3_ledger_reconciliation_v0236(env_t)') IS NULL THEN
    ALTER FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
      RENAME TO matriz_stage3_ledger_reconciliation_v0236;
  END IF;
END
$rename$;

CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_reconciliation(p_environment env_t)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,finance,commerce,core,audit AS $fn$
  SELECT finance.matriz_stage3_ledger_reconciliation_v0236(p_environment)
    || jsonb_build_object(
      'retail_revenue_missing', (
        SELECT count(*) FROM finance.v_matriz_retail_realization r
        JOIN commerce.orders o ON o.environment=r.environment AND o.id=r.order_id
        WHERE r.environment=p_environment AND r.was_realized AND o.total_amount>0
          AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment AND t.source_id=o.id::text
              AND t.source_type='commerce.order.revenue')
      ),
      'retail_stock_decrement_missing', (
        SELECT count(*) FROM finance.v_matriz_retail_realization r
        WHERE r.environment=p_environment AND r.was_realized
          AND EXISTS (SELECT 1 FROM commerce.order_items i
            JOIN commerce.tire_specs s ON s.environment=i.environment AND s.product_id=i.product_id
            WHERE i.environment=r.environment AND i.order_id=r.order_id)
          AND NOT EXISTS (SELECT 1 FROM audit.events a
            WHERE a.environment=r.environment AND a.entity_id=r.order_id
              AND a.event_type='matriz_galpao_decrement')
      ),
      'retail_cogs_missing', (
        SELECT count(*) FROM finance.v_matriz_retail_realization r
        WHERE r.environment=p_environment AND r.was_realized
          AND EXISTS (SELECT 1 FROM audit.events a
            WHERE a.environment=r.environment AND a.entity_id=r.order_id
              AND a.event_type='matriz_galpao_decrement')
          AND EXISTS (SELECT 1 FROM commerce.order_items i
            WHERE i.environment=r.environment AND i.order_id=r.order_id
            GROUP BY i.order_id HAVING COALESCE(sum(i.quantity*i.matriz_unit_cost),0)>0)
          AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=r.environment AND t.source_id=r.order_id::text
              AND t.source_type='commerce.order.cogs')
      )
    );
$fn$;
REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t) FROM PUBLIC,farejador_partner_app;

COMMENT ON VIEW finance.v_matriz_retail_realization IS
  'Realização do varejo da Matriz: reserva/custo não bastam. Cancelamentos preservam a evidência de venda anterior e suas datas.';
COMMIT;
