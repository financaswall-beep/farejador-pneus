-- 0182 — Estoque ponta a ponta: custo reversível, identidade do recebimento,
-- total de compra fechado e filme da matriz reconstruível desde a abertura.

-- O custo médio precisa de precisão suficiente para entradas ponderadas e
-- estornos. Valores digitados continuam em centavos; a média derivada usa 6 casas.
ALTER TABLE commerce.partner_stock_levels
  ALTER COLUMN average_cost TYPE NUMERIC(18,6)
  USING average_cost::numeric(18,6);

CREATE OR REPLACE FUNCTION commerce.guard_partner_stock_inactivation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
     AND COALESCE(OLD.quantity_reserved,0)>0 THEN
    RAISE EXCEPTION 'stock_reserved_cannot_delete' USING ERRCODE='23514';
  END IF;
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
     AND COALESCE(OLD.quantity_on_hand,0)>0 THEN
    RAISE EXCEPTION 'stock_positive_cannot_delete' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_stock_inactivation_guard
  ON commerce.partner_stock_levels;
CREATE TRIGGER partner_stock_inactivation_guard
  BEFORE UPDATE OF deleted_at ON commerce.partner_stock_levels
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_partner_stock_inactivation();

CREATE OR REPLACE FUNCTION commerce.guard_partner_purchase_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.purchased_at>clock_timestamp()+interval '5 minutes' THEN
    RAISE EXCEPTION 'partner_purchased_at_future' USING ERRCODE='23514';
  END IF;
  IF NEW.payment_status='payable' AND NEW.payable_due_date IS NOT NULL
     AND NEW.payable_due_date<(NEW.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'partner_payable_due_before_purchase' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_purchase_dates_guard
  ON commerce.partner_purchases;
CREATE TRIGGER partner_purchase_dates_guard
  BEFORE INSERT OR UPDATE OF purchased_at,payable_due_date,payment_status
  ON commerce.partner_purchases
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_partner_purchase_dates();

ALTER TABLE commerce.partner_purchase_items
  ADD COLUMN IF NOT EXISTS received_stock_id UUID,
  ADD COLUMN IF NOT EXISTS received_stock_quantity_before INTEGER,
  ADD COLUMN IF NOT EXISTS received_stock_average_cost_before NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS received_stock_quantity_after INTEGER,
  ADD COLUMN IF NOT EXISTS received_stock_average_cost_after NUMERIC(18,6);

ALTER TABLE commerce.partner_purchase_items
  DROP CONSTRAINT IF EXISTS partner_purchase_items_received_stock_fk;
ALTER TABLE commerce.partner_purchase_items
  ADD CONSTRAINT partner_purchase_items_received_stock_fk
  FOREIGN KEY (received_stock_id)
  REFERENCES commerce.partner_stock_levels(id)
  ON DELETE SET NULL;

ALTER TABLE commerce.partner_purchase_items
  DROP CONSTRAINT IF EXISTS partner_purchase_items_received_stock_snapshot_check;
ALTER TABLE commerce.partner_purchase_items
  ADD CONSTRAINT partner_purchase_items_received_stock_snapshot_check CHECK (
    (received_stock_quantity_before IS NULL OR received_stock_quantity_before >= 0)
    AND (received_stock_quantity_after IS NULL OR received_stock_quantity_after >= 0)
    AND (received_stock_average_cost_before IS NULL OR received_stock_average_cost_before >= 0)
    AND (received_stock_average_cost_after IS NULL OR received_stock_average_cost_after >= 0)
    AND (
      received_stock_quantity_before IS NULL
      OR received_stock_quantity_after IS NULL
      OR received_quantity IS NULL
      OR received_stock_quantity_after
         = received_stock_quantity_before + received_quantity
    )
  );

DROP TRIGGER IF EXISTS env_match_partner_purchase_item_received_stock
  ON commerce.partner_purchase_items;
CREATE TRIGGER env_match_partner_purchase_item_received_stock
  BEFORE INSERT OR UPDATE OF received_stock_id
  ON commerce.partner_purchase_items
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'commerce','partner_stock_levels','received_stock_id'
  );

CREATE OR REPLACE FUNCTION commerce.assert_partner_purchase_item_stock_unit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=commerce,pg_catalog
AS $function$
DECLARE
  v_purchase_unit uuid;
  v_stock_unit uuid;
BEGIN
  IF NEW.received_stock_id IS NULL THEN RETURN NEW; END IF;
  SELECT unit_id INTO v_purchase_unit
    FROM commerce.partner_purchases
   WHERE environment=NEW.environment AND id=NEW.purchase_id;
  SELECT unit_id INTO v_stock_unit
    FROM commerce.partner_stock_levels
   WHERE environment=NEW.environment AND id=NEW.received_stock_id;
  IF v_purchase_unit IS NULL OR v_stock_unit IS NULL OR v_purchase_unit<>v_stock_unit THEN
    RAISE EXCEPTION 'partner_purchase_received_stock_unit_mismatch'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_purchase_item_received_stock_unit_guard
  ON commerce.partner_purchase_items;
CREATE TRIGGER partner_purchase_item_received_stock_unit_guard
  BEFORE INSERT OR UPDATE OF purchase_id,received_stock_id
  ON commerce.partner_purchase_items
  FOR EACH ROW EXECUTE FUNCTION commerce.assert_partner_purchase_item_stock_unit();

CREATE INDEX IF NOT EXISTS partner_purchase_items_received_stock_idx
  ON commerce.partner_purchase_items(environment,received_stock_id)
  WHERE received_stock_id IS NOT NULL;

-- Recupera o vínculo exato para recebimentos já auditados. O evento antigo já
-- guardava item_id, stock_id, quantidade recebida e saldo posterior.
WITH evidence AS (
  SELECT event.environment,
         (movement->>'item_id')::uuid AS item_id,
         (movement->>'stock_id')::uuid AS stock_id,
         (movement->>'received_quantity')::integer AS received_quantity,
         (movement->>'new_qty')::integer AS quantity_after,
         row_number() OVER (
           PARTITION BY event.environment,movement->>'item_id'
           ORDER BY event.created_at DESC,event.id DESC
         ) AS position
    FROM audit.events event
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(event.payload_after->'moves')='array'
        THEN event.payload_after->'moves' ELSE '[]'::jsonb END
    ) movement
   WHERE event.event_type='stock_increment_purchase'
     AND movement ? 'item_id' AND movement ? 'stock_id'
), valid_evidence AS (
  SELECT evidence.*
    FROM evidence
    JOIN commerce.partner_stock_levels stock
      ON stock.environment=evidence.environment AND stock.id=evidence.stock_id
   WHERE evidence.position=1
)
UPDATE commerce.partner_purchase_items item
   SET received_stock_id=evidence.stock_id,
       received_stock_quantity_before=CASE
         WHEN evidence.quantity_after IS NULL OR evidence.received_quantity IS NULL THEN NULL
         ELSE evidence.quantity_after-evidence.received_quantity END,
       received_stock_quantity_after=evidence.quantity_after
  FROM valid_evidence evidence
 WHERE item.environment=evidence.environment AND item.id=evidence.item_id
   AND item.received_stock_id IS NULL;

-- Idempotência de uma loja nunca pode colidir com a chave de outra loja.
DROP INDEX IF EXISTS commerce.partner_purchases_idempotency_uniq;
CREATE UNIQUE INDEX partner_purchases_idempotency_uniq
  ON commerce.partner_purchases(environment,unit_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Fecha a equação da compra no próprio banco:
-- cabeçalho = soma(quantidade × custo unitário), sempre em centavos.
CREATE OR REPLACE FUNCTION commerce.assert_partner_purchase_total()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=commerce,pg_catalog
AS $function$
DECLARE
  v_environment public.env_t;
  v_purchase_id uuid;
  v_header numeric;
  v_items numeric;
BEGIN
  IF TG_TABLE_NAME='partner_purchases' THEN
    v_environment := COALESCE(NEW.environment,OLD.environment);
    v_purchase_id := COALESCE(NEW.id,OLD.id);
  ELSE
    v_environment := COALESCE(NEW.environment,OLD.environment);
    v_purchase_id := COALESCE(NEW.purchase_id,OLD.purchase_id);
  END IF;

  SELECT purchase.total_amount,
         COALESCE(sum(item.quantity*item.unit_cost),0)
    INTO v_header,v_items
    FROM commerce.partner_purchases purchase
    LEFT JOIN commerce.partner_purchase_items item
      ON item.environment=purchase.environment AND item.purchase_id=purchase.id
   WHERE purchase.environment=v_environment AND purchase.id=v_purchase_id
   GROUP BY purchase.total_amount;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF round(v_header,2)<>round(v_items,2) THEN
    RAISE EXCEPTION 'partner_purchase_total_mismatch:%:%',v_header,v_items
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS partner_purchase_total_from_header
  ON commerce.partner_purchases;
CREATE CONSTRAINT TRIGGER partner_purchase_total_from_header
AFTER INSERT OR UPDATE ON commerce.partner_purchases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commerce.assert_partner_purchase_total();

DROP TRIGGER IF EXISTS partner_purchase_total_from_items
  ON commerce.partner_purchase_items;
CREATE CONSTRAINT TRIGGER partner_purchase_total_from_items
AFTER INSERT OR UPDATE OR DELETE ON commerce.partner_purchase_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commerce.assert_partner_purchase_total();

-- A trilha da matriz nasceu depois de duas posições de estoque. Só cria uma
-- abertura quando a primeira linha é UPDATE e o qty_before prova exatamente a
-- diferença entre saldo atual e soma de deltas; assim não mascara corrupção.
WITH movement_sum AS (
  SELECT environment,measure,brand,tire_condition,
         sum(qty_delta)::integer AS delta_sum
    FROM commerce.wholesale_stock_movements
   GROUP BY environment,measure,brand,tire_condition
), first_movement AS (
  SELECT DISTINCT ON (environment,measure,brand,tire_condition)
         environment,measure,brand,tire_condition,op,qty_before,cost_before,created_at
    FROM commerce.wholesale_stock_movements
   ORDER BY environment,measure,brand,tire_condition,created_at,id
), proven_opening AS (
  SELECT stock.environment,stock.measure,stock.brand,stock.tire_condition,
         first.qty_before,first.cost_before,first.created_at
    FROM commerce.wholesale_stock stock
    JOIN movement_sum movement
      USING (environment,measure,brand,tire_condition)
    JOIN first_movement first
      USING (environment,measure,brand,tire_condition)
   WHERE first.op='update'
     AND first.qty_before=stock.quantity_on_hand-movement.delta_sum
     AND movement.delta_sum<>stock.quantity_on_hand
)
INSERT INTO commerce.wholesale_stock_movements (
  environment,measure,brand,tire_condition,op,qty_before,qty_after,
  cost_before,cost_after,source,reason,ref,created_at
)
SELECT environment,measure,brand,tire_condition,'insert',0,qty_before,
       NULL,cost_before,'opening_balance_backfill',
       'Saldo de abertura comprovado pela primeira movimentação (0182)',
       'migration:0182',created_at-interval '1 microsecond'
  FROM proven_opening;

-- Executa agora os constraint triggers diferidos para que a própria migration
-- prove seus corpos e os dados existentes antes do COMMIT.
SET CONSTRAINTS ALL IMMEDIATE;

DO $smoke$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM commerce.partner_purchases purchase
   WHERE purchase.deleted_at IS NULL
     AND purchase.total_amount<>(
       SELECT COALESCE(sum(item.quantity*item.unit_cost),0)
         FROM commerce.partner_purchase_items item
        WHERE item.environment=purchase.environment
          AND item.purchase_id=purchase.id
     );
  IF v_count<>0 THEN
    RAISE EXCEPTION '0182: compras com total divergente: %',v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM commerce.partner_purchases
   WHERE purchased_at>clock_timestamp()+interval '5 minutes'
      OR (payment_status='payable' AND payable_due_date IS NOT NULL
          AND payable_due_date<(purchased_at AT TIME ZONE 'America/Sao_Paulo')::date);
  IF v_count<>0 THEN
    RAISE EXCEPTION '0182: compras com datas impossiveis: %',v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM commerce.partner_purchase_items item
    JOIN commerce.partner_purchases purchase
      ON purchase.environment=item.environment AND purchase.id=item.purchase_id
    JOIN commerce.partner_stock_levels stock
      ON stock.environment=item.environment AND stock.id=item.received_stock_id
   WHERE purchase.unit_id<>stock.unit_id;
  IF v_count<>0 THEN
    RAISE EXCEPTION '0182: recebimentos ligados a outra loja: %',v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM commerce.wholesale_stock stock
   WHERE COALESCE((
     SELECT sum(movement.qty_delta)
       FROM commerce.wholesale_stock_movements movement
      WHERE movement.environment=stock.environment
        AND movement.measure=stock.measure AND movement.brand=stock.brand
        AND movement.tire_condition=stock.tire_condition
   ),0)<>stock.quantity_on_hand;
  IF v_count<>0 THEN
    RAISE EXCEPTION '0182: filme da matriz ainda diverge em % variante(s)',v_count;
  END IF;
END;
$smoke$;
