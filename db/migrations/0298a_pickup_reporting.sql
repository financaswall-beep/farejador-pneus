BEGIN;

ALTER TABLE commerce.orders ADD COLUMN pickup_ready_at timestamptz;
ALTER TABLE commerce.partner_orders ADD COLUMN pickup_ready_at timestamptz;

COMMENT ON COLUMN commerce.orders.pickup_ready_at IS
  'Horário em que o operador confirmou que os itens foram separados para retirada.';
COMMENT ON COLUMN commerce.partner_orders.pickup_ready_at IS
  'Horário em que o operador confirmou que os itens foram separados para retirada.';

CREATE FUNCTION commerce.pickup_reservation_deadline(
  o commerce.orders, p commerce.partner_orders, hours integer
) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
  SELECT CASE WHEN hours > 0
    AND commerce.bot_order_cancellation_allowed(o,p,'infinity'::timestamptz)
    THEN GREATEST(o.created_at,o.fulfillment_not_before) + hours * interval '1 hour'
  END
$fn$;
REVOKE ALL ON FUNCTION commerce.pickup_reservation_deadline(commerce.orders,commerce.partner_orders,integer)
  FROM PUBLIC;

-- O portal não tem acesso direto aos pedidos espelho. Retorna apenas dados
-- do pedido de retirada da própria unidade autenticada.
CREATE FUNCTION commerce.partner_pickup_metadata(
  p_environment public.env_t, p_order_id uuid, hours integer
) RETURNS TABLE(order_number text,reservation_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
  SELECT o.order_number::text,commerce.pickup_reservation_deadline(o,p,hours)
  FROM network.partner_units unit
  JOIN commerce.partner_orders p ON p.environment=unit.environment AND p.unit_id=unit.unit_id
  JOIN commerce.orders o ON o.environment=p.environment AND o.unit_id=p.unit_id AND o.partner_order_id=p.id
  WHERE unit.id=network.current_partner_unit() AND unit.environment=p_environment
    AND p.id=p_order_id AND p.fulfillment_mode='pickup' AND p.deleted_at IS NULL
$fn$;
REVOKE ALL ON FUNCTION commerce.partner_pickup_metadata(public.env_t,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.partner_pickup_metadata(public.env_t,uuid,integer) TO farejador_partner_app;

COMMIT;
