-- 0178: integridade causal da aba Vendas da Matriz.
-- Fecha os vínculos de ambiente/unidade, conversa/contato e valores por linha.

DROP TRIGGER IF EXISTS env_match_orders_unit ON commerce.orders;
CREATE TRIGGER env_match_orders_unit
  BEFORE INSERT OR UPDATE OF unit_id ON commerce.orders
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

CREATE OR REPLACE FUNCTION commerce.validate_order_conversation_contact()
RETURNS trigger AS $fn$
DECLARE
  v_contact_id uuid;
BEGIN
  IF NEW.source_conversation_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT contact_id INTO v_contact_id
    FROM core.conversations
   WHERE id=NEW.source_conversation_id AND environment=NEW.environment;
  IF NOT FOUND OR v_contact_id IS NULL THEN
    RAISE EXCEPTION 'conversation_contact_not_found';
  END IF;
  IF NEW.contact_id IS DISTINCT FROM v_contact_id THEN
    RAISE EXCEPTION 'conversation_contact_mismatch';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_conversation_contact_match ON commerce.orders;
CREATE TRIGGER orders_conversation_contact_match
  BEFORE INSERT OR UPDATE OF source_conversation_id,contact_id ON commerce.orders
  FOR EACH ROW EXECUTE FUNCTION commerce.validate_order_conversation_contact();

ALTER TABLE commerce.order_items
  DROP CONSTRAINT IF EXISTS order_items_discount_within_line_check;
ALTER TABLE commerce.order_items
  ADD CONSTRAINT order_items_discount_within_line_check
  CHECK (discount_amount >= 0 AND discount_amount <= quantity*unit_price) NOT VALID;

ALTER TABLE commerce.wholesale_orders
  DROP CONSTRAINT IF EXISTS wholesale_orders_payment_dates_check;
ALTER TABLE commerce.wholesale_orders
  ADD CONSTRAINT wholesale_orders_payment_dates_check CHECK (
    (paid_at IS NULL OR paid_at >= sold_at)
    AND (due_date IS NULL OR due_date >= (sold_at AT TIME ZONE 'America/Sao_Paulo')::date)
  ) NOT VALID;

COMMENT ON TRIGGER env_match_orders_unit ON commerce.orders IS
  '0178: impede pedido prod/test apontar para unidade de outro ambiente.';
COMMENT ON TRIGGER orders_conversation_contact_match ON commerce.orders IS
  '0178: pedido Chatwoot só pode usar o contato da própria conversa.';
