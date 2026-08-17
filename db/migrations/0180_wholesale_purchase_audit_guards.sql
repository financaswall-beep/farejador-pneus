-- 0180 - Fechamento das auditorias funcional e matematica de Compras da Matriz.
-- Corrige precisao do custo medio, datas factuais futuras e o estorno composto
-- de compra que nasceu em transito, foi recebida e depois cancelada sem pagar.

-- Seis casas preservam o valor medio ponderado. Valores comerciais continuam
-- sendo apresentados e lancados no livro em centavos.
ALTER TABLE commerce.wholesale_stock
  ALTER COLUMN unit_cost TYPE NUMERIC(18,6) USING unit_cost::NUMERIC(18,6);

COMMENT ON COLUMN commerce.wholesale_stock.unit_cost IS
  '0180: custo medio ponderado com seis casas; exibicao e fatos financeiros arredondam para centavos apenas na borda.';

CREATE OR REPLACE FUNCTION commerce.validate_wholesale_purchase_dates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,commerce
AS $fn$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_purchase_date DATE := (NEW.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF v_purchase_date>v_today THEN
    RAISE EXCEPTION 'purchased_at_future' USING ERRCODE='23514';
  END IF;
  IF NEW.paid_at IS NOT NULL
     AND (NEW.paid_at AT TIME ZONE 'America/Sao_Paulo')::date>v_today THEN
    RAISE EXCEPTION 'paid_at_future' USING ERRCODE='23514';
  END IF;
  IF NEW.due_date IS NOT NULL AND NEW.due_date<v_purchase_date THEN
    RAISE EXCEPTION 'due_date_before_purchase' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS wholesale_purchases_dates_guard
  ON commerce.wholesale_purchases;
CREATE TRIGGER wholesale_purchases_dates_guard
  BEFORE INSERT OR UPDATE OF purchased_at,paid_at,due_date
  ON commerce.wholesale_purchases
  FOR EACH ROW EXECUTE FUNCTION commerce.validate_wholesale_purchase_dates();

COMMENT ON TRIGGER wholesale_purchases_dates_guard
  ON commerce.wholesale_purchases IS
  '0180: compra e pagamento sao fatos e nao podem estar no futuro; vencimento pode ser futuro, mas nao anterior a compra.';

REVOKE ALL ON FUNCTION commerce.validate_wholesale_purchase_dates() FROM PUBLIC;

-- Repara, de modo idempotente, o unico caminho antigo que podia deixar
-- inventory positivo e inventory_in_transit negativo depois do cancelamento.
DO $repair$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.environment,p.id,p.cancelled_at,p.cancelled_by,p.cancel_reason,
           receipt.id AS receipt_transaction_id
      FROM commerce.wholesale_purchases p
      JOIN finance.matriz_ledger_transactions accrual
        ON accrual.environment=p.environment
       AND accrual.source_type='commerce.wholesale_purchase.accrual'
       AND accrual.source_id=p.id::text
      JOIN finance.matriz_ledger_transactions receipt
        ON receipt.environment=p.environment
       AND receipt.source_type='commerce.wholesale_purchase.receipt'
       AND receipt.source_id=p.id::text
      JOIN finance.matriz_ledger_transactions cancellation
        ON cancellation.environment=p.environment
       AND cancellation.source_type='commerce.wholesale_purchase.cancel'
       AND cancellation.source_id=p.id::text
       AND cancellation.reversal_of_transaction_id=accrual.id
     WHERE p.status='cancelled' AND p.cancelled_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM finance.matriz_ledger_transactions fixed
          WHERE fixed.environment=p.environment
            AND fixed.source_type='commerce.wholesale_purchase.receipt_cancel'
            AND fixed.source_id=p.id::text
       )
  LOOP
    PERFORM finance.reverse_matriz_ledger_transaction(
      r.environment,
      r.receipt_transaction_id,
      'commerce.wholesale_purchase.receipt_cancel',
      r.id::text,
      (r.cancelled_at AT TIME ZONE 'America/Sao_Paulo')::date,
      'Estorno do recebimento de compra cancelada',
      COALESCE(NULLIF(btrim(r.cancelled_by),''),'system:migration-0180'),
      NULL,
      jsonb_build_object(
        'purchase_id',r.id,
        'reason',COALESCE(r.cancel_reason,'Correcao matematica 0180'),
        'repair_migration','0180'
      )
    );
  END LOOP;
END
$repair$;

-- O gate passa a enxergar tambem a metade ausente do estorno composto.
CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_reconciliation(
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
      'purchase_receipt_cancel_missing', (
        SELECT count(*) FROM commerce.wholesale_purchases p
         WHERE p.environment=p_environment AND p.status='cancelled'
           AND EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions receipt
              WHERE receipt.environment=p.environment
                AND receipt.source_type='commerce.wholesale_purchase.receipt'
                AND receipt.source_id=p.id::text
           )
           AND EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions cancelled
              WHERE cancelled.environment=p.environment
                AND cancelled.source_type='commerce.wholesale_purchase.cancel'
                AND cancelled.source_id=p.id::text
                AND cancelled.reversal_of_transaction_id IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions receipt_cancel
              WHERE receipt_cancel.environment=p.environment
                AND receipt_cancel.source_type='commerce.wholesale_purchase.receipt_cancel'
                AND receipt_cancel.source_id=p.id::text
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
      ),
      'retail_stock_decrement_missing', (
        SELECT count(*) FROM commerce.orders o
         JOIN core.units u
           ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
         WHERE o.environment=p_environment AND o.partner_order_id IS NULL
           AND o.status IN ('confirmed','paid','delivered','cancelled')
           AND NOT (
             o.status='cancelled' AND EXISTS (
               SELECT 1 FROM audit.events released
                WHERE released.environment=o.environment
                  AND released.entity_id=o.id
                  AND released.event_type='matriz_galpao_reservation_released'
             )
           )
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
      )
    );
$fn$;

COMMENT ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t) IS
  'Gate Etapa 3; 0180 detecta tambem estorno ausente do recebimento de compra cancelada.';

REVOKE ALL ON FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
  FROM PUBLIC;

DO $check$
DECLARE
  v_precision INTEGER;
  v_scale INTEGER;
  v_key BOOLEAN;
BEGIN
  SELECT numeric_precision,numeric_scale INTO v_precision,v_scale
    FROM information_schema.columns
   WHERE table_schema='commerce' AND table_name='wholesale_stock'
     AND column_name='unit_cost';
  IF v_precision<>18 OR v_scale<>6 THEN
    RAISE EXCEPTION '0180: precisao do custo medio incorreta: (%,%)',v_precision,v_scale;
  END IF;
  SELECT finance.matriz_stage3_ledger_reconciliation('test')
         ? 'purchase_receipt_cancel_missing' INTO v_key;
  IF NOT v_key THEN
    RAISE EXCEPTION '0180: gate sem purchase_receipt_cancel_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='commerce.wholesale_purchases'::regclass
       AND tgname='wholesale_purchases_dates_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0180: trigger de datas nao instalado';
  END IF;
END
$check$;
