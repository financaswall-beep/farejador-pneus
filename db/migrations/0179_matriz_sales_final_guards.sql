-- 0179: guardas finais da auditoria de Vendas da Matriz.
-- Impede datas comerciais futuras no banco e indexa a chave normalizada usada
-- para travar somente as medidas envolvidas na venda de varejo.

CREATE OR REPLACE FUNCTION commerce.validate_wholesale_order_future_dates()
RETURNS trigger AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF NEW.sold_at IS NOT NULL
     AND (NEW.sold_at AT TIME ZONE 'America/Sao_Paulo')::date > v_today THEN
    RAISE EXCEPTION 'sold_at_future' USING ERRCODE = '23514';
  END IF;
  IF NEW.paid_at IS NOT NULL
     AND (NEW.paid_at AT TIME ZONE 'America/Sao_Paulo')::date > v_today THEN
    RAISE EXCEPTION 'paid_at_future' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wholesale_orders_future_dates_guard
  ON commerce.wholesale_orders;
CREATE TRIGGER wholesale_orders_future_dates_guard
  BEFORE INSERT OR UPDATE OF sold_at, paid_at ON commerce.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION commerce.validate_wholesale_order_future_dates();

CREATE OR REPLACE FUNCTION commerce.wholesale_measure_key(p_measure text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $fn$
  SELECT array_to_string((regexp_split_to_array(
    regexp_replace(p_measure, '^[^0-9]+|[^0-9]+$', '', 'g'),
    '[^0-9]+'
  ))[1:3], '-');
$fn$;

CREATE INDEX IF NOT EXISTS wholesale_stock_normalized_measure_idx
  ON commerce.wholesale_stock (
    environment,
    (commerce.wholesale_measure_key(measure))
  );

COMMENT ON TRIGGER wholesale_orders_future_dates_guard
  ON commerce.wholesale_orders IS
  '0179: venda e recebimento podem ser hoje ou no passado, nunca em data futura de Sao Paulo.';
COMMENT ON INDEX commerce.wholesale_stock_normalized_measure_idx IS
  '0179: acelera o lock apenas das medidas pedidas pela venda de varejo.';
