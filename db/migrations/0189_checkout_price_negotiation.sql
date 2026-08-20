BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('farejador:migration:0189_checkout_price_negotiation', 0));

-- O preco efetivamente cobrado continua em unit_price. Esta nova coluna guarda
-- o preco oficial vigente quando a linha foi criada, permitindo auditar desconto
-- ou acrescimo sem alterar catalogo, estoque, custo ou vendas antigas.
ALTER TABLE commerce.order_items
  ADD COLUMN IF NOT EXISTS reference_unit_price NUMERIC(10, 2);

ALTER TABLE commerce.partner_order_items
  ADD COLUMN IF NOT EXISTS reference_unit_price NUMERIC(10, 2);

UPDATE commerce.order_items
   SET reference_unit_price = unit_price
 WHERE reference_unit_price IS NULL;

UPDATE commerce.partner_order_items
   SET reference_unit_price = unit_price
 WHERE reference_unit_price IS NULL;

ALTER TABLE commerce.order_items
  ALTER COLUMN reference_unit_price SET NOT NULL;

ALTER TABLE commerce.partner_order_items
  ALTER COLUMN reference_unit_price SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'order_items_reference_price_nonnegative'
       AND conrelid = 'commerce.order_items'::regclass
  ) THEN
    ALTER TABLE commerce.order_items
      ADD CONSTRAINT order_items_reference_price_nonnegative
      CHECK (reference_unit_price >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'partner_order_items_reference_price_nonnegative'
       AND conrelid = 'commerce.partner_order_items'::regclass
  ) THEN
    ALTER TABLE commerce.partner_order_items
      ADD CONSTRAINT partner_order_items_reference_price_nonnegative
      CHECK (reference_unit_price >= 0);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION commerce.fill_matrix_order_item_reference_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.reference_unit_price := COALESCE(NEW.reference_unit_price, NEW.unit_price);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION commerce.fill_partner_order_item_reference_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_official NUMERIC(10, 2);
BEGIN
  IF NEW.partner_stock_id IS NOT NULL THEN
    SELECT sale_price
      INTO v_official
      FROM commerce.partner_stock_levels
     WHERE id = NEW.partner_stock_id
       AND environment = NEW.environment
       AND unit_id = (
         SELECT unit_id FROM commerce.partner_orders
          WHERE id = NEW.order_id AND environment = NEW.environment
       );
  END IF;
  -- Em item ligado ao estoque, o banco prevalece sobre qualquer referência
  -- enviada pelo navegador. Itens livres preservam a referência recebida.
  NEW.reference_unit_price := COALESCE(v_official, NEW.reference_unit_price, NEW.unit_price);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_items_reference_price_default
  ON commerce.order_items;
CREATE TRIGGER order_items_reference_price_default
BEFORE INSERT ON commerce.order_items
FOR EACH ROW
EXECUTE FUNCTION commerce.fill_matrix_order_item_reference_price();

DROP TRIGGER IF EXISTS partner_order_items_reference_price_default
  ON commerce.partner_order_items;
CREATE TRIGGER partner_order_items_reference_price_default
BEFORE INSERT ON commerce.partner_order_items
FOR EACH ROW
EXECUTE FUNCTION commerce.fill_partner_order_item_reference_price();

COMMENT ON COLUMN commerce.order_items.reference_unit_price IS
  'Preco oficial vigente no fechamento. unit_price e o preco efetivamente negociado e faturado.';
COMMENT ON COLUMN commerce.partner_order_items.reference_unit_price IS
  'Preco oficial da unidade no fechamento. unit_price e o preco efetivamente negociado e faturado.';

COMMIT;
