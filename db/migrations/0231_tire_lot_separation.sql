BEGIN;
-- Separation transfers existing catalog stock, without another purchase/payable.
ALTER TABLE commerce.tire_lots ALTER COLUMN purchase_id DROP NOT NULL;
ALTER TABLE commerce.tire_lots ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'purchase'
  CHECK (origin_type IN ('purchase','separation'));
ALTER TABLE commerce.tire_lots ADD COLUMN origin_stock_id UUID;
ALTER TABLE commerce.tire_lots ADD COLUMN origin_snapshot JSONB;
ALTER TABLE commerce.tire_lots ADD CONSTRAINT tire_lot_origin_check CHECK (
 (origin_type='purchase' AND purchase_id IS NOT NULL AND origin_stock_id IS NULL AND origin_snapshot IS NULL)
 OR (origin_type='separation' AND purchase_id IS NULL AND origin_stock_id IS NOT NULL
     AND origin_snapshot IS NOT NULL AND accepted_quantity=ordered_quantity));
ALTER TABLE commerce.tire_lots DROP CONSTRAINT tire_lots_products_amount_check;
ALTER TABLE commerce.tire_lots ADD CHECK (products_amount>=0);
ALTER TABLE commerce.tire_lot_movements DROP CONSTRAINT tire_lot_movements_source_check;
ALTER TABLE commerce.tire_lot_movements ADD CHECK (source IN ('purchase_receipt','purchase_cancel','separation_in'));
CREATE INDEX tire_lots_created_idx ON commerce.tire_lots(environment,created_at DESC,id);

CREATE OR REPLACE VIEW commerce.wholesale_purchase_lines AS
 SELECT i.id,i.environment,i.purchase_id,i.measure,i.brand,i.tire_condition,
   i.quantity,i.ordered_quantity,i.accepted_quantity,i.unit_cost,i.line_total,
   i.allocated_cost,'catalog'::text item_kind FROM commerce.wholesale_purchase_items i
 UNION ALL
 SELECT l.id,l.environment,l.purchase_id,'Lote: '||l.description,NULL::text,NULL::text,
   l.ordered_quantity,l.ordered_quantity,l.accepted_quantity,
   l.products_amount/l.ordered_quantity,l.products_amount,l.allocated_cost,'lot'::text
 FROM commerce.tire_lots l WHERE l.origin_type='purchase';

CREATE FUNCTION commerce.preserve_tire_lot_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.environment,NEW.purchase_id,NEW.origin_type,NEW.origin_stock_id,NEW.origin_snapshot,
        NEW.ordered_quantity,NEW.products_amount,NEW.allocated_cost)
 IS DISTINCT FROM ROW(OLD.environment,OLD.purchase_id,OLD.origin_type,OLD.origin_stock_id,OLD.origin_snapshot,
        OLD.ordered_quantity,OLD.products_amount,OLD.allocated_cost) THEN
   RAISE EXCEPTION 'lot_origin_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tire_lot_origin_immutable BEFORE UPDATE ON commerce.tire_lots
 FOR EACH ROW EXECUTE FUNCTION commerce.preserve_tire_lot_origin();
REVOKE ALL ON FUNCTION commerce.preserve_tire_lot_origin() FROM PUBLIC;
COMMIT;
