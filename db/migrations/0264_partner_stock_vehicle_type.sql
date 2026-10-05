BEGIN;

-- A escolha explícita do parceiro pertence ao estoque local, não altera o catálogo.
-- Itens históricos sem classificação continuam NULL, sem inferir pelo aro/medida.
ALTER TABLE commerce.partner_stock_levels
  ADD COLUMN vehicle_type text CHECK (vehicle_type IN ('motorcycle','car'));

CREATE FUNCTION commerce.capture_partner_stock_vehicle_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE catalog_type text;
BEGIN
  IF NEW.item_type='pneu' AND NEW.product_id IS NOT NULL THEN
    SELECT ts.vehicle_type INTO catalog_type FROM commerce.tire_specs ts
      WHERE ts.environment=NEW.environment AND ts.product_id=NEW.product_id;
    IF NEW.vehicle_type IS NOT NULL AND catalog_type IS NOT NULL
      AND NEW.vehicle_type<>catalog_type THEN
      RAISE EXCEPTION 'stock_vehicle_type_conflict' USING ERRCODE='23514';
    END IF;
    NEW.vehicle_type:=COALESCE(NEW.vehicle_type,catalog_type);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION commerce.capture_partner_stock_vehicle_type() FROM PUBLIC;
CREATE TRIGGER partner_stock_vehicle_type_capture
  BEFORE INSERT OR UPDATE OF vehicle_type,product_id,environment
  ON commerce.partner_stock_levels
  FOR EACH ROW EXECUTE FUNCTION commerce.capture_partner_stock_vehicle_type();
COMMENT ON COLUMN commerce.partner_stock_levels.vehicle_type IS
  'Carro/Moto informado no cadastro local ou confirmado pelo produto vinculado; sem inferência por medida.';

COMMIT;
