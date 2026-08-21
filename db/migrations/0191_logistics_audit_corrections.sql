-- 0191 - Correcoes confirmadas pela auditoria ponta a ponta da Logistica.
-- Escopo estrito: retorno fisico do parceiro, limite concorrente de comprovantes
-- e reconciliacao que nao exige receita de entrega ainda nao realizada.

-- A implementacao historica de cancelamento libera reserva apenas para
-- pending/dispatched. Preservamos a funcao e a envolvemos para que uma falha
-- reportada (failed) tambem libere RESERVA, nunca infle o estoque fisico.
DO $rename$
BEGIN
  IF to_regprocedure('commerce.cancel_partner_local_order_v0090(uuid,text,text)') IS NULL THEN
    ALTER FUNCTION commerce.cancel_partner_local_order(uuid,text,text)
      RENAME TO cancel_partner_local_order_v0090;
  END IF;
END
$rename$;

CREATE OR REPLACE FUNCTION commerce.cancel_partner_local_order(
  p_order_id uuid,
  p_actor_label text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  v_changed_rows integer := 0;
BEGIN
  UPDATE commerce.partner_orders
     SET delivery_status='dispatched'
   WHERE id=p_order_id AND status<>'cancelled'
     AND fulfillment_mode='delivery' AND delivery_status='failed';
  GET DIAGNOSTICS v_changed_rows = ROW_COUNT;

  PERFORM commerce.cancel_partner_local_order_v0090(
    p_order_id,p_actor_label,p_reason
  );

  IF v_changed_rows > 0 THEN
    UPDATE commerce.partner_orders
       SET delivery_status='failed'
     WHERE id=p_order_id AND status='cancelled';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION commerce.cancel_partner_local_order(uuid,text,text)
  FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    GRANT EXECUTE ON FUNCTION commerce.cancel_partner_local_order(uuid,text,text)
      TO farejador_partner_app;
  END IF;
END
$grant$;

-- Serializa qualquer insercao de comprovante pela propria rota. Assim, 49 +
-- dois uploads simultaneos termina em 50, independentemente do caminho de API.
CREATE OR REPLACE FUNCTION commerce.enforce_matriz_trip_receipt_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_count integer;
BEGIN
  PERFORM 1
    FROM commerce.matriz_delivery_trips trip
   WHERE trip.environment=NEW.environment AND trip.id=NEW.trip_id
     AND trip.deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trip_not_found' USING ERRCODE='23503';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM commerce.matriz_trip_receipts receipt
   WHERE receipt.environment=NEW.environment AND receipt.trip_id=NEW.trip_id;
  IF v_count >= 50 THEN
    RAISE EXCEPTION 'receipt_limit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS matriz_trip_receipt_limit_guard
  ON commerce.matriz_trip_receipts;
CREATE TRIGGER matriz_trip_receipt_limit_guard
  BEFORE INSERT ON commerce.matriz_trip_receipts
  FOR EACH ROW EXECUTE FUNCTION commerce.enforce_matriz_trip_receipt_limit();

-- A auditoria financeira nao deve acusar fato ausente para uma entrega ainda
-- pendente. O fato nasce somente quando delivery_status=delivered.
DO $rename$
BEGIN
  IF to_regprocedure('finance.matriz_stage3_ledger_reconciliation_v0190(env_t)') IS NULL THEN
    ALTER FUNCTION finance.matriz_stage3_ledger_reconciliation(env_t)
      RENAME TO matriz_stage3_ledger_reconciliation_v0190;
  END IF;
END
$rename$;

CREATE OR REPLACE FUNCTION finance.matriz_stage3_ledger_reconciliation(
  p_environment env_t
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,finance,commerce,core,audit
AS $function$
  SELECT finance.matriz_stage3_ledger_reconciliation_v0190(p_environment)
    || jsonb_build_object('retail_revenue_missing',(
      SELECT count(*)
        FROM commerce.orders o
        JOIN core.units u
          ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
       WHERE o.environment=p_environment AND o.partner_order_id IS NULL
         AND o.total_amount>0
         AND o.status IN ('confirmed','paid','delivered','cancelled')
         AND (
           o.fulfillment_mode<>'delivery'
           OR o.delivery_status='delivered'
           OR EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions legacy
              WHERE legacy.environment=o.environment
                AND legacy.source_type='commerce.order.revenue'
                AND legacy.source_id=o.id::text
           )
         )
         AND (o.status<>'cancelled'
           OR EXISTS (SELECT 1 FROM audit.events a
             WHERE a.environment=o.environment AND a.entity_id=o.id
               AND a.event_type='matriz_galpao_decrement')
           OR EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
             WHERE t.environment=o.environment AND t.source_id=o.id::text
               AND t.source_type IN ('commerce.order.revenue','commerce.order.cogs'))
           OR EXISTS (SELECT 1 FROM commerce.order_items i
             WHERE i.environment=o.environment AND i.order_id=o.id
               AND i.matriz_unit_cost IS NOT NULL))
         AND NOT EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions t
            WHERE t.environment=o.environment
              AND t.source_type='commerce.order.revenue'
              AND t.source_id=o.id::text)
    ));
$function$;

REVOKE ALL ON FUNCTION
  finance.matriz_stage3_ledger_reconciliation_v0190(env_t) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  finance.matriz_stage3_ledger_reconciliation(env_t) FROM PUBLIC;
DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON FUNCTION
      finance.matriz_stage3_ledger_reconciliation_v0190(env_t)
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION
      finance.matriz_stage3_ledger_reconciliation(env_t)
      FROM farejador_partner_app;
  END IF;
END
$security$;

DO $assertions$
BEGIN
  IF to_regprocedure('commerce.cancel_partner_local_order_v0090(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '0191_cancel_base_missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='commerce.matriz_trip_receipts'::regclass
        AND tgname='matriz_trip_receipt_limit_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '0191_receipt_limit_guard_missing';
  END IF;
  IF to_regprocedure('finance.matriz_stage3_ledger_reconciliation_v0190(env_t)') IS NULL THEN
    RAISE EXCEPTION '0191_reconciliation_base_missing';
  END IF;
END
$assertions$;
