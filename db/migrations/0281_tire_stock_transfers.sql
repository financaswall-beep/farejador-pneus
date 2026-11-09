BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Versão aumenta mesmo quando uma venda/reserva é desfeita: evita estornar por comparação de saldo.
CREATE SEQUENCE commerce.inventory_revision_seq;
REVOKE ALL ON SEQUENCE commerce.inventory_revision_seq FROM PUBLIC;
CREATE FUNCTION commerce.bump_inventory_revision() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
BEGIN NEW.inventory_revision := nextval('commerce.inventory_revision_seq'); RETURN NEW; END $$;
ALTER TABLE commerce.wholesale_stock ADD COLUMN inventory_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE commerce.wholesale_stock ADD CONSTRAINT wholesale_stock_environment_id_key UNIQUE(environment,id);
ALTER TABLE commerce.products ADD CONSTRAINT products_environment_id_key UNIQUE(environment,id);
ALTER TABLE commerce.tire_lots ADD COLUMN inventory_revision BIGINT NOT NULL DEFAULT 0;
CREATE TRIGGER inventory_revision BEFORE INSERT OR UPDATE ON commerce.wholesale_stock
 FOR EACH ROW EXECUTE FUNCTION commerce.bump_inventory_revision();
CREATE TRIGGER inventory_revision BEFORE INSERT OR UPDATE ON commerce.tire_lots
 FOR EACH ROW EXECUTE FUNCTION commerce.bump_inventory_revision();

CREATE TABLE commerce.tire_stock_transfers (
 id UUID PRIMARY KEY,
 environment env_t NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('to_stock','to_lot','loss','reversal')),
 lot_id UUID NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity>0),
 cost NUMERIC(12,2) NOT NULL CHECK(cost>=0),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 500),
 created_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 before_lot JSONB,
 after_lot JSONB NOT NULL,
 reversal_of UUID,
 UNIQUE(environment,id), UNIQUE(environment,reversal_of),
 FOREIGN KEY(environment,lot_id) REFERENCES commerce.tire_lots(environment,id) ON DELETE RESTRICT,
 FOREIGN KEY(environment,reversal_of) REFERENCES commerce.tire_stock_transfers(environment,id),
 CHECK((kind='reversal')=(reversal_of IS NOT NULL))
);
CREATE TABLE commerce.tire_stock_transfer_items (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 environment env_t NOT NULL,
 transfer_id UUID NOT NULL,
 stock_id UUID NOT NULL,
 product_id UUID,
 quantity INTEGER NOT NULL CHECK(quantity>0),
 cost NUMERIC(12,2) NOT NULL CHECK(cost>=0),
 before_stock JSONB,
 after_stock JSONB NOT NULL,
 UNIQUE(environment,transfer_id,stock_id),
 FOREIGN KEY(environment,transfer_id) REFERENCES commerce.tire_stock_transfers(environment,id),
 FOREIGN KEY(environment,stock_id) REFERENCES commerce.wholesale_stock(environment,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(environment,product_id) REFERENCES commerce.products(environment,id)
);
CREATE INDEX tire_stock_transfers_lot_idx ON commerce.tire_stock_transfers(environment,lot_id,created_at DESC,id);
CREATE INDEX tire_stock_transfer_items_stock_idx ON commerce.tire_stock_transfer_items(environment,stock_id,transfer_id);
CREATE TRIGGER tire_stock_transfer_immutable BEFORE UPDATE OR DELETE ON commerce.tire_stock_transfers
 FOR EACH ROW EXECUTE FUNCTION commerce.preserve_tire_lot_movement();
CREATE TRIGGER tire_stock_transfer_item_immutable BEFORE UPDATE OR DELETE ON commerce.tire_stock_transfer_items
 FOR EACH ROW EXECUTE FUNCTION commerce.preserve_tire_lot_movement();

-- A operação só fecha se as duas pontas conservarem quantidade e centavos.
CREATE FUNCTION commerce.assert_tire_stock_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t commerce.tire_stock_transfers%ROWTYPE; original commerce.tire_stock_transfers%ROWTYPE;
 q INTEGER; c NUMERIC; n INTEGER; sign INTEGER; is_loss BOOLEAN;
BEGIN
 IF TG_TABLE_NAME='tire_stock_transfers' THEN
 SELECT * INTO t FROM commerce.tire_stock_transfers WHERE id=NEW.id AND environment=NEW.environment;
 ELSE SELECT * INTO t FROM commerce.tire_stock_transfers WHERE id=NEW.transfer_id AND environment=NEW.environment; END IF;
 IF t.kind='reversal' THEN
 SELECT * INTO original FROM commerce.tire_stock_transfers WHERE id=t.reversal_of AND environment=t.environment;
 IF original.kind='reversal' OR original.lot_id<>t.lot_id OR original.quantity<>t.quantity OR original.cost<>t.cost THEN
 RAISE EXCEPTION 'transfer_invalid_reversal'; END IF;
 END IF;
 is_loss := t.kind='loss' OR (t.kind='reversal' AND original.kind='loss');
 sign := CASE WHEN t.kind='to_lot' OR (t.kind='reversal' AND original.kind<>'to_lot') THEN 1 ELSE -1 END;
 IF (t.after_lot->>'quantity_on_hand')::int-COALESCE((t.before_lot->>'quantity_on_hand')::int,0)<>sign*t.quantity
 OR (t.after_lot->>'remaining_cost')::numeric-COALESCE((t.before_lot->>'remaining_cost')::numeric,0)<>sign*t.cost THEN
 RAISE EXCEPTION 'transfer_lot_does_not_close'; END IF;
 SELECT count(*)::int,COALESCE(sum(quantity),0),COALESCE(sum(cost),0) INTO n,q,c
 FROM commerce.tire_stock_transfer_items WHERE environment=t.environment AND transfer_id=t.id;
 IF (is_loss AND n<>0) OR (NOT is_loss AND (q<>t.quantity OR c<>t.cost)) THEN
 RAISE EXCEPTION 'transfer_items_do_not_close'; END IF;
 IF NOT is_loss AND EXISTS(SELECT 1 FROM commerce.tire_stock_transfer_items i
 WHERE i.environment=t.environment AND i.transfer_id=t.id AND (
 (i.after_stock->>'quantity_on_hand')::int-COALESCE((i.before_stock->>'quantity_on_hand')::int,0)<>-sign*i.quantity
 OR round((i.after_stock->>'quantity_on_hand')::numeric*(i.after_stock->>'unit_cost')::numeric,2)
 -COALESCE(round((i.before_stock->>'quantity_on_hand')::numeric*(i.before_stock->>'unit_cost')::numeric,2),0)<>-sign*i.cost)) THEN
 RAISE EXCEPTION 'transfer_stock_does_not_close'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tire_stock_transfer_integrity AFTER INSERT ON commerce.tire_stock_transfers
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.assert_tire_stock_transfer();
CREATE CONSTRAINT TRIGGER tire_stock_transfer_item_integrity AFTER INSERT ON commerce.tire_stock_transfer_items
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.assert_tire_stock_transfer();
REVOKE ALL ON FUNCTION commerce.assert_tire_stock_transfer() FROM PUBLIC;

ALTER TABLE commerce.tire_lot_movements ADD COLUMN transfer_id UUID;
ALTER TABLE commerce.tire_lot_movements ADD CONSTRAINT lot_movement_transfer_fk
 FOREIGN KEY(environment,transfer_id) REFERENCES commerce.tire_stock_transfers(environment,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE commerce.tire_lot_movements ADD CONSTRAINT tire_lot_movements_environment_id_key UNIQUE(environment,id);
ALTER TABLE commerce.tire_lot_movements DROP CONSTRAINT tire_lot_movements_source_check;
ALTER TABLE commerce.tire_lot_movements ADD CHECK(source IN
 ('purchase_receipt','purchase_cancel','separation_in','sale','sale_cancel','transfer_out','transfer_reversal','triage_loss'));
ALTER TABLE commerce.tire_lot_movements ADD CHECK(
 (source IN ('transfer_out','transfer_reversal','triage_loss'))=(transfer_id IS NOT NULL));
DROP INDEX commerce.tire_lot_movement_origin_uq;
CREATE UNIQUE INDEX tire_lot_movement_origin_uq ON commerce.tire_lot_movements(environment,lot_id,source)
 WHERE order_id IS NULL AND transfer_id IS NULL;
CREATE UNIQUE INDEX tire_lot_movement_transfer_uq ON commerce.tire_lot_movements(environment,transfer_id)
 WHERE transfer_id IS NOT NULL;

-- Perda do lote usa o mesmo livro de ajustes, mas aponta para o movimento do lote.
ALTER TABLE finance.matriz_inventory_adjustments ALTER COLUMN stock_movement_id DROP NOT NULL;
ALTER TABLE finance.matriz_inventory_adjustments ADD COLUMN lot_movement_id UUID;
ALTER TABLE finance.matriz_inventory_adjustments ADD CHECK(
 (stock_movement_id IS NOT NULL)::int+(lot_movement_id IS NOT NULL)::int=1);
ALTER TABLE finance.matriz_inventory_adjustments ADD CONSTRAINT inventory_adjustment_lot_movement_fk
 FOREIGN KEY(environment,lot_movement_id) REFERENCES commerce.tire_lot_movements(environment,id);
CREATE UNIQUE INDEX inventory_adjustment_lot_movement_uq
 ON finance.matriz_inventory_adjustments(environment,lot_movement_id) WHERE lot_movement_id IS NOT NULL;

ALTER TABLE commerce.tire_stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.tire_stock_transfer_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.tire_stock_transfers,commerce.tire_stock_transfer_items FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.bump_inventory_revision() FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','partner_app','farejador_partner_app'] LOOP
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
 EXECUTE format('REVOKE ALL ON commerce.tire_stock_transfers,commerce.tire_stock_transfer_items FROM %I',r);
 END IF; END LOOP;
END $$;
COMMIT;
