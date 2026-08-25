BEGIN;

ALTER TABLE commerce.wholesale_suppliers
  ADD CONSTRAINT wholesale_suppliers_environment_id_uniq UNIQUE (environment, id);

ALTER TABLE commerce.wholesale_purchases
  ADD CONSTRAINT wholesale_purchases_environment_id_uniq UNIQUE (environment, id);

CREATE TABLE commerce.wholesale_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  order_number BIGINT GENERATED ALWAYS AS IDENTITY,
  supplier_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','closed','cancelled')),
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) BETWEEN 2 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  closed_by TEXT,
  notes TEXT,
  UNIQUE (environment, order_number),
  UNIQUE (environment, id),
  FOREIGN KEY (environment, supplier_id)
    REFERENCES commerce.wholesale_suppliers(environment, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((status = 'open' AND closed_at IS NULL)
      OR (status <> 'open' AND closed_at IS NOT NULL))
);

CREATE INDEX wholesale_purchase_orders_supplier_status_idx
  ON commerce.wholesale_purchase_orders(environment, supplier_id, status, created_at DESC);

ALTER TABLE commerce.wholesale_purchases
  ADD COLUMN purchase_order_id UUID,
  ADD COLUMN supplier_reference TEXT,
  ADD COLUMN products_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN freight_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN payment_method TEXT;

UPDATE commerce.wholesale_purchases
   SET products_amount = total_amount
 WHERE products_amount = 0 AND total_amount <> 0;

ALTER TABLE commerce.wholesale_purchases
  ADD CONSTRAINT wholesale_purchases_order_fk
    FOREIGN KEY (environment, purchase_order_id)
    REFERENCES commerce.wholesale_purchase_orders(environment, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT wholesale_purchases_supplier_reference_len_ck
    CHECK (supplier_reference IS NULL OR length(btrim(supplier_reference)) BETWEEN 1 AND 160),
  ADD CONSTRAINT wholesale_purchases_payment_method_len_ck
    CHECK (payment_method IS NULL OR length(btrim(payment_method)) BETWEEN 1 AND 60),
  ADD CONSTRAINT wholesale_purchases_amount_parts_ck
    CHECK (products_amount >= 0 AND freight_amount >= 0 AND discount_amount >= 0
      AND discount_amount <= products_amount + freight_amount
      AND total_amount = products_amount + freight_amount - discount_amount);

CREATE INDEX wholesale_purchases_order_idx
  ON commerce.wholesale_purchases(environment, purchase_order_id, purchased_at DESC)
  WHERE purchase_order_id IS NOT NULL;

ALTER TABLE commerce.wholesale_purchase_items
  ADD COLUMN ordered_quantity INTEGER,
  ADD COLUMN accepted_quantity INTEGER,
  ADD COLUMN allocated_cost NUMERIC(12,2);

UPDATE commerce.wholesale_purchase_items i
   SET ordered_quantity = i.quantity,
       accepted_quantity = CASE WHEN p.stock_applied THEN i.quantity ELSE NULL END,
       allocated_cost = i.line_total
  FROM commerce.wholesale_purchases p
 WHERE p.environment=i.environment AND p.id=i.purchase_id;

ALTER TABLE commerce.wholesale_purchase_items
  ALTER COLUMN ordered_quantity SET NOT NULL,
  ALTER COLUMN allocated_cost SET NOT NULL,
  ADD CONSTRAINT wholesale_purchase_items_ordered_quantity_ck
    CHECK (ordered_quantity > 0),
  ADD CONSTRAINT wholesale_purchase_items_accepted_quantity_ck
    CHECK (accepted_quantity IS NULL OR accepted_quantity BETWEEN 0 AND ordered_quantity),
  ADD CONSTRAINT wholesale_purchase_items_allocated_cost_ck
    CHECK (allocated_cost >= 0);

CREATE TABLE commerce.wholesale_purchase_installments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  purchase_id UUID NOT NULL,
  installment_number INTEGER NOT NULL CHECK (installment_number > 0),
  due_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, purchase_id, installment_number),
  FOREIGN KEY (environment, purchase_id)
    REFERENCES commerce.wholesale_purchases(environment, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX wholesale_purchase_installments_due_idx
  ON commerce.wholesale_purchase_installments(environment, due_date, purchase_id);

INSERT INTO commerce.wholesale_purchase_installments
  (environment,purchase_id,installment_number,due_date,amount)
SELECT environment,id,1,
       COALESCE(due_date,(purchased_at AT TIME ZONE 'America/Sao_Paulo')::date),
       total_amount
  FROM commerce.wholesale_purchases
 WHERE payment_status='pending' AND status<>'cancelled'
   AND total_amount>0
ON CONFLICT (environment,purchase_id,installment_number) DO NOTHING;

-- As duas invariantes abaixo ficam DEFERRED: a API insere o cabeçalho, os itens
-- e as parcelas em etapas, mas o banco só aceita o COMMIT quando tudo fecha.
CREATE OR REPLACE FUNCTION commerce.assert_wholesale_purchase_0208()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_environment env_t;
  v_purchase_id UUID;
  v_purchase commerce.wholesale_purchases%ROWTYPE;
  v_installments NUMERIC(12,2);
  v_allocated NUMERIC(12,2);
  v_items INTEGER;
  v_accepted_nulls INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'wholesale_purchases' THEN
    v_environment := NEW.environment;
    v_purchase_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_environment := OLD.environment;
    v_purchase_id := OLD.purchase_id;
  ELSE
    v_environment := NEW.environment;
    v_purchase_id := NEW.purchase_id;
  END IF;

  SELECT * INTO v_purchase FROM commerce.wholesale_purchases
   WHERE environment=v_environment AND id=v_purchase_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(amount),0) INTO v_installments
    FROM commerce.wholesale_purchase_installments
   WHERE environment=v_environment AND purchase_id=v_purchase_id;
  IF v_purchase.status<>'cancelled' AND v_purchase.payment_status='pending'
     AND v_purchase.total_amount>0 AND v_installments<>v_purchase.total_amount THEN
    RAISE EXCEPTION 'purchase_installments_do_not_close' USING ERRCODE='23514';
  END IF;

  SELECT count(*)::int,COALESCE(sum(allocated_cost),0),
         count(*) FILTER (WHERE accepted_quantity IS NULL)::int
    INTO v_items,v_allocated,v_accepted_nulls
    FROM commerce.wholesale_purchase_items
   WHERE environment=v_environment AND purchase_id=v_purchase_id;
  IF v_items=0 OR v_allocated<>v_purchase.total_amount THEN
    RAISE EXCEPTION 'purchase_items_do_not_close' USING ERRCODE='23514';
  END IF;
  IF v_purchase.stock_applied AND v_accepted_nulls<>0 THEN
    RAISE EXCEPTION 'purchase_received_items_incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER wholesale_purchases_0208_integrity
AFTER INSERT OR UPDATE OF total_amount,payment_status,status,stock_applied
ON commerce.wholesale_purchases DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commerce.assert_wholesale_purchase_0208();

CREATE CONSTRAINT TRIGGER wholesale_purchase_items_0208_integrity
AFTER INSERT OR UPDATE OR DELETE ON commerce.wholesale_purchase_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commerce.assert_wholesale_purchase_0208();

CREATE CONSTRAINT TRIGGER wholesale_purchase_installments_0208_integrity
AFTER INSERT OR UPDATE OR DELETE ON commerce.wholesale_purchase_installments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commerce.assert_wholesale_purchase_0208();

CREATE TRIGGER env_immutable_wholesale_purchase_orders
BEFORE UPDATE OF environment ON commerce.wholesale_purchase_orders
FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

CREATE TRIGGER env_immutable_wholesale_purchase_installments
BEFORE UPDATE OF environment ON commerce.wholesale_purchase_installments
FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

DO $security$
DECLARE v_role BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') INTO v_role;
  IF v_role AND (has_table_privilege('farejador_partner_app',
       'commerce.wholesale_purchase_orders','SELECT')
    OR has_table_privilege('farejador_partner_app',
       'commerce.wholesale_purchase_installments','SELECT')) THEN
    RAISE EXCEPTION '0208 falhou: dados de compra da Matriz expostos ao parceiro';
  END IF;
END;
$security$;

COMMENT ON TABLE commerce.wholesale_purchase_orders IS
  '0208: agrupador operacional de compras; vincular uma compra nao movimenta estoque nem financeiro.';
COMMENT ON COLUMN commerce.wholesale_purchase_items.allocated_cost IS
  '0208: custo total do item apos rateio deterministico de frete e desconto; a soma fecha com total_amount.';
COMMENT ON TABLE commerce.wholesale_purchase_installments IS
  '0208: agenda contratual da obrigacao unica da compra; pagamentos continuam alocados no livro central.';

COMMIT;
