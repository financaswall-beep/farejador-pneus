-- Abertura física e aceitação comercial são independentes. Só os novos pedidos
-- da Matriz feitos fora do expediente recebem esta janela; histórico permanece igual.
ALTER TABLE commerce.orders ADD COLUMN fulfillment_not_before timestamptz;
ALTER TABLE commerce.orders ADD CONSTRAINT matriz_order_window_only CHECK(fulfillment_not_before IS NULL OR partner_order_id IS NULL);
COMMENT ON COLUMN commerce.orders.fulfillment_not_before IS
 'Primeiro instante de atendimento do pedido após a abertura da Matriz; prazo de reserva começa aqui quando posterior à criação.';

CREATE OR REPLACE FUNCTION commerce.bot_order_cancellation_allowed(
  o commerce.orders,p commerce.partner_orders,expire_before timestamptz DEFAULT NULL
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT COALESCE(o.id IS NOT NULL AND o.status='open'
  AND o.retrieved_at IS NULL AND o.delivered_at IS NULL
  AND o.pickup_arrived_at IS NULL AND o.pickup_installation_started_at IS NULL
  AND (o.partner_order_id IS NULL OR (
   p.id=o.partner_order_id AND p.environment=o.environment AND p.unit_id=o.unit_id
   AND p.status<>'cancelled' AND p.deleted_at IS NULL
   AND p.pickup_arrived_at IS NULL AND p.pickup_installation_started_at IS NULL
   AND ((p.fulfillment_mode='pickup' AND p.awaiting_pickup)
    OR (p.fulfillment_mode='delivery' AND p.delivery_status='pending'))
  )) AND (expire_before IS NULL OR (
   o.fulfillment_mode='pickup' AND o.idempotency_key LIKE 'bot:order:%'
   AND GREATEST(o.created_at,CASE WHEN o.partner_order_id IS NULL THEN o.fulfillment_not_before END)<=expire_before
   AND (o.partner_order_id IS NULL OR p.fulfillment_mode='pickup')
  )),false)
$fn$;
REVOKE ALL ON FUNCTION commerce.bot_order_cancellation_allowed(commerce.orders,commerce.partner_orders,timestamptz) FROM PUBLIC;

CREATE FUNCTION commerce.guard_matriz_fulfillment_window() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF GREATEST(OLD.fulfillment_not_before,NEW.fulfillment_not_before)>clock_timestamp()
  AND NEW.status<>'cancelled' AND (
   (NEW.retrieved_at IS NOT NULL AND OLD.retrieved_at IS NULL)
   OR (NEW.delivered_at IS NOT NULL AND OLD.delivered_at IS NULL)
   OR (NEW.pickup_arrived_at IS NOT NULL AND OLD.pickup_arrived_at IS NULL)
   OR (NEW.pickup_installation_started_at IS NOT NULL AND OLD.pickup_installation_started_at IS NULL)
   OR (NEW.delivery_status IN ('dispatched','delivered') AND NEW.delivery_status IS DISTINCT FROM OLD.delivery_status)
  ) THEN RAISE EXCEPTION 'order_not_available_yet'; END IF;
 RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION commerce.guard_matriz_fulfillment_window() FROM PUBLIC;
CREATE TRIGGER matriz_fulfillment_window BEFORE UPDATE ON commerce.orders
FOR EACH ROW EXECUTE FUNCTION commerce.guard_matriz_fulfillment_window();
