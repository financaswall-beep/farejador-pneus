-- Uma tentativa antiga continua vinculada ao pedido original após encerramento.
BEGIN;
CREATE TABLE ops.bot_order_attempts (
  environment env_t NOT NULL,
  conversation_id UUID NOT NULL REFERENCES core.conversations(id),
  request_message_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES commerce.orders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment,conversation_id,request_message_id)
);
CREATE TRIGGER bot_order_attempt_conversation_env BEFORE INSERT ON ops.bot_order_attempts
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','conversations','conversation_id');
CREATE TRIGGER bot_order_attempt_order_env BEFORE INSERT ON ops.bot_order_attempts
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','orders','order_id');
CREATE TRIGGER bot_order_attempt_env_immutable BEFORE UPDATE OF environment ON ops.bot_order_attempts
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
ALTER TABLE ops.bot_order_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.bot_order_attempts FROM PUBLIC;

-- Uma só política: seleção e cancelamento sob trava recebem os mesmos registros.
-- Sem limite de data, preserva o cancelamento solicitado pelo cliente (inclusive entrega).
CREATE FUNCTION commerce.bot_order_cancellation_allowed(
  o commerce.orders, p commerce.partner_orders, expire_before timestamptz DEFAULT NULL
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
    ))
    AND (expire_before IS NULL OR (
      o.fulfillment_mode='pickup' AND o.idempotency_key LIKE 'bot:order:%'
      AND o.created_at<=expire_before
      AND (o.partner_order_id IS NULL OR p.fulfillment_mode='pickup')
    )),false)
$fn$;
REVOKE ALL ON FUNCTION commerce.bot_order_cancellation_allowed(commerce.orders,commerce.partner_orders,timestamptz) FROM PUBLIC;

-- Estado operacional de tentativas, separado dos pedidos e do payload bruto.
CREATE TABLE ops.bot_reservation_expiry_failures (
  environment env_t NOT NULL,
  order_id uuid NOT NULL REFERENCES commerce.orders(id),
  attempts integer NOT NULL CHECK(attempts>0),
  last_failed_at timestamptz NOT NULL,
  retry_after timestamptz NOT NULL,
  error_code text NOT NULL,
  PRIMARY KEY(environment,order_id)
);
CREATE TRIGGER bot_expiry_failure_env BEFORE INSERT OR UPDATE ON ops.bot_reservation_expiry_failures
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','orders','order_id');
CREATE TRIGGER bot_expiry_failure_env_immutable BEFORE UPDATE OF environment ON ops.bot_reservation_expiry_failures
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
ALTER TABLE ops.bot_reservation_expiry_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.bot_reservation_expiry_failures FROM PUBLIC;

-- Valida novamente DEPOIS de aguardar retirada/entrega concorrente.
CREATE FUNCTION commerce.cancel_open_bot_order(p_environment env_t,p_id UUID,p_actor TEXT,p_reason TEXT,
  p_expire_before timestamptz DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog,commerce AS $fn$
DECLARE v commerce.orders%ROWTYPE; p commerce.partner_orders%ROWTYPE;
BEGIN
  SELECT * INTO v FROM commerce.orders WHERE environment=p_environment AND id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v.partner_order_id IS NOT NULL THEN
    SELECT * INTO p FROM commerce.partner_orders
      WHERE environment=p_environment AND id=v.partner_order_id FOR UPDATE;
  END IF;
  SELECT * INTO v FROM commerce.orders WHERE environment=p_environment AND id=p_id FOR UPDATE;
  IF NOT commerce.bot_order_cancellation_allowed(v,p,p_expire_before) THEN
    RAISE EXCEPTION 'order_status_changed';
  END IF;
  IF v.partner_order_id IS NOT NULL THEN
    PERFORM commerce.cancel_partner_local_order(v.partner_order_id,p_actor,p_reason);
  END IF;
  PERFORM commerce.cancel_manual_order(p_id,p_actor,p_reason);
END
$fn$;
REVOKE ALL ON FUNCTION commerce.cancel_open_bot_order(env_t,UUID,TEXT,TEXT,timestamptz) FROM PUBLIC;
DO $smoke$
BEGIN
  IF to_regclass('ops.bot_order_attempts') IS NULL
    OR to_regprocedure('commerce.cancel_open_bot_order(env_t,uuid,text,text,timestamptz)') IS NULL
    OR to_regclass('ops.bot_reservation_expiry_failures') IS NULL THEN
    RAISE EXCEPTION '0255: protecao dos pedidos do bot ausente';
  END IF;
END
$smoke$;
COMMIT;
