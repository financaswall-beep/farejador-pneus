-- 0187 - Venda Matriz -> parceiro so vira receita no acerto da chegada.
--
-- A saida fisica transfere o custo para estoque em transito. Enquanto o
-- parceiro nao confirmar pneu por pneu, a venda e o pagamento permanecem
-- pendentes. "A vista" significa pagamento no acerto, nao caixa na expedicao.

ALTER TABLE commerce.wholesale_orders
  ADD COLUMN IF NOT EXISTS partner_payment_terms TEXT;

UPDATE commerce.wholesale_orders
   SET partner_payment_terms=CASE WHEN payment_status='paid'
                                  THEN 'cash_on_arrival' ELSE 'credit' END
 WHERE partner_unit_id IS NOT NULL AND partner_payment_terms IS NULL;

ALTER TABLE commerce.wholesale_orders
  DROP CONSTRAINT IF EXISTS wholesale_orders_status_check;
ALTER TABLE commerce.wholesale_orders
  ADD CONSTRAINT wholesale_orders_status_check
  CHECK (status IN ('pending','confirmed','cancelled'));

ALTER TABLE commerce.wholesale_orders
  DROP CONSTRAINT IF EXISTS wholesale_orders_partner_payment_terms_check;
ALTER TABLE commerce.wholesale_orders
  ADD CONSTRAINT wholesale_orders_partner_payment_terms_check CHECK (
    (partner_unit_id IS NULL AND partner_payment_terms IS NULL)
    OR
    (partner_unit_id IS NOT NULL
      AND partner_payment_terms IN ('cash_on_arrival','credit'))
  );

ALTER TABLE commerce.wholesale_orders
  DROP CONSTRAINT IF EXISTS wholesale_orders_partner_transfer_lifecycle_check;
ALTER TABLE commerce.wholesale_orders
  ADD CONSTRAINT wholesale_orders_partner_transfer_lifecycle_check CHECK (
    partner_transfer_status IS NULL
    OR (partner_transfer_status='in_transit'
      AND status='pending' AND payment_status='pending' AND paid_at IS NULL)
    OR (partner_transfer_status IN ('settled','received') AND status='confirmed')
  ) NOT VALID;

COMMENT ON COLUMN commerce.wholesale_orders.partner_payment_terms IS
  'Condicao combinada para transferencia: cash_on_arrival ou credit. O pagamento so e efetivado apos o acerto.';

-- Um acrescimo pode apontar para a carga raiz ainda pendente e em transito.
CREATE OR REPLACE FUNCTION commerce.guard_wholesale_partner_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce,network
AS $$
DECLARE
  v_buyer_partner UUID;
  v_unit_partner UUID;
  v_parent RECORD;
BEGIN
  SELECT partner_id INTO v_buyer_partner
    FROM commerce.wholesale_customers
   WHERE id=NEW.buyer_id AND environment=NEW.environment AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wholesale_buyer_not_found' USING ERRCODE='23503';
  END IF;

  IF NEW.partner_unit_id IS NOT NULL THEN
    SELECT partner_id INTO v_unit_partner
      FROM network.partner_units
     WHERE id=NEW.partner_unit_id AND environment=NEW.environment
       AND status='active' AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'wholesale_partner_unit_not_active' USING ERRCODE='23514';
    END IF;
    IF v_buyer_partner IS NULL OR v_unit_partner IS DISTINCT FROM v_buyer_partner THEN
      RAISE EXCEPTION 'wholesale_partner_unit_buyer_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.parent_order_id IS NOT NULL THEN
    IF NEW.parent_order_id=NEW.id THEN
      RAISE EXCEPTION 'wholesale_addition_self_parent' USING ERRCODE='23514';
    END IF;
    SELECT buyer_id,partner_unit_id,parent_order_id,status,partner_transfer_status
      INTO v_parent
      FROM commerce.wholesale_orders
     WHERE id=NEW.parent_order_id AND environment=NEW.environment;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'wholesale_parent_order_not_found' USING ERRCODE='23503';
    END IF;
    IF v_parent.parent_order_id IS NOT NULL
       OR NOT (v_parent.status='confirmed'
         OR (v_parent.status='pending' AND v_parent.partner_transfer_status='in_transit')) THEN
      RAISE EXCEPTION 'wholesale_parent_order_not_open_root' USING ERRCODE='23514';
    END IF;
    IF v_parent.buyer_id IS DISTINCT FROM NEW.buyer_id THEN
      RAISE EXCEPTION 'wholesale_addition_buyer_mismatch' USING ERRCODE='23514';
    END IF;
    IF v_parent.partner_unit_id IS NOT NULL
       AND v_parent.partner_unit_id IS DISTINCT FROM NEW.partner_unit_id THEN
      RAISE EXCEPTION 'wholesale_addition_partner_unit_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- A compra espelhada acompanha o estagio da carga, e nao apenas a opcao
-- escolhida no formulario. Antes do acerto, inclusive a vista e "payable".
CREATE OR REPLACE FUNCTION commerce.guard_matrix_linked_partner_purchase()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce,network
AS $$
DECLARE
  v_source RECORD;
  v_bridge BOOLEAN := COALESCE(current_setting('app.matrix_partner_bridge',true),'')='on'
    AND session_user<>'farejador_partner_app';
BEGIN
  IF TG_OP='UPDATE' AND OLD.source_wholesale_order_id IS NOT NULL AND NOT v_bridge
     AND ROW(NEW.environment,NEW.unit_id,NEW.supplier_name,NEW.purchased_at,
             NEW.total_amount,NEW.payment_method,NEW.notes,NEW.created_by,
             NEW.idempotency_key,NEW.payment_status,NEW.payable_due_date,
             NEW.deleted_at,NEW.deleted_by,NEW.source_wholesale_order_id)
         IS DISTINCT FROM
         ROW(OLD.environment,OLD.unit_id,OLD.supplier_name,OLD.purchased_at,
             OLD.total_amount,OLD.payment_method,OLD.notes,OLD.created_by,
             OLD.idempotency_key,OLD.payment_status,OLD.payable_due_date,
             OLD.deleted_at,OLD.deleted_by,OLD.source_wholesale_order_id) THEN
    RAISE EXCEPTION 'matrix_linked_purchase_immutable' USING ERRCODE='23514';
  END IF;

  IF NEW.source_wholesale_order_id IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(o.settled_total_amount,o.total_amount) total_amount,
         o.sold_at,o.payment_status,o.due_date,o.partner_transfer_status,
         o.partner_payment_terms,pu.unit_id,
         COALESCE(o.due_date,
           (o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date) expected_due_date
    INTO v_source
    FROM commerce.wholesale_orders o
    JOIN network.partner_units pu
      ON pu.environment=o.environment AND pu.id=o.partner_unit_id
   WHERE o.environment=NEW.environment AND o.id=NEW.source_wholesale_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'matrix_linked_purchase_source_invalid' USING ERRCODE='23503';
  END IF;
  IF NEW.unit_id IS DISTINCT FROM v_source.unit_id THEN
    RAISE EXCEPTION 'matrix_linked_purchase_unit_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.total_amount IS DISTINCT FROM v_source.total_amount THEN
    RAISE EXCEPTION 'matrix_linked_purchase_total_mismatch:%:%',NEW.total_amount,v_source.total_amount
      USING ERRCODE='23514';
  END IF;
  IF NEW.purchased_at IS DISTINCT FROM v_source.sold_at THEN
    RAISE EXCEPTION 'matrix_linked_purchase_date_mismatch:%:%',NEW.purchased_at,v_source.sold_at
      USING ERRCODE='23514';
  END IF;
  IF NOT (
       (v_source.partner_transfer_status='in_transit'
         AND NEW.payment_status='payable'
         AND NEW.payable_due_date IS NOT DISTINCT FROM v_source.expected_due_date)
       OR (v_source.partner_transfer_status IN ('settled','received')
         AND v_source.payment_status='pending'
         AND NEW.payment_status='payable'
         AND NEW.payable_due_date IS NOT DISTINCT FROM v_source.due_date)
       OR (v_source.partner_transfer_status IN ('settled','received')
         AND v_source.payment_status='paid'
         AND NEW.payment_status='paid_now' AND NEW.payable_due_date IS NULL)
     ) THEN
    RAISE EXCEPTION 'matrix_linked_purchase_payment_mismatch:%:%:%:%:%',
      NEW.payment_status,NEW.payable_due_date,v_source.payment_status,
      v_source.due_date,v_source.partner_transfer_status USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- O estado pendente e os campos financeiros da carga em transito so podem
-- mudar dentro da operacao atomica de acerto da Matriz.
CREATE OR REPLACE FUNCTION commerce.guard_matrix_partner_arrival_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce
AS $$
DECLARE
  v_allowed BOOLEAN := COALESCE(current_setting('app.matrix_partner_arrival',true),'')='on'
    AND session_user<>'farejador_partner_app';
BEGIN
  IF OLD.partner_unit_id IS NULL AND NEW.partner_unit_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.partner_payment_terms IS DISTINCT FROM OLD.partner_payment_terms THEN
    RAISE EXCEPTION 'matrix_partner_payment_terms_immutable' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.partner_unit_id,NEW.partner_transfer_status,NEW.settled_total_amount)
     IS DISTINCT FROM
     ROW(OLD.partner_unit_id,OLD.partner_transfer_status,OLD.settled_total_amount)
     AND NOT v_allowed THEN
    RAISE EXCEPTION 'matrix_partner_arrival_operation_required' USING ERRCODE='23514';
  END IF;
  IF OLD.partner_transfer_status='in_transit'
     AND ROW(NEW.status,NEW.payment_status,NEW.paid_at)
       IS DISTINCT FROM ROW(OLD.status,OLD.payment_status,OLD.paid_at)
     AND NOT v_allowed THEN
    RAISE EXCEPTION 'matrix_partner_arrival_operation_required' USING ERRCODE='23514';
  END IF;
  IF OLD.partner_transfer_status IS DISTINCT FROM NEW.partner_transfer_status
     AND NOT (
       (OLD.partner_transfer_status='in_transit' AND NEW.partner_transfer_status='settled')
       OR (OLD.partner_transfer_status='settled' AND NEW.partner_transfer_status='received')
     ) THEN
    RAISE EXCEPTION 'matrix_partner_transfer_transition_invalid:%:%',
      OLD.partner_transfer_status,NEW.partner_transfer_status USING ERRCODE='23514';
  END IF;
  IF OLD.partner_transfer_status='in_transit'
     AND NEW.partner_transfer_status='settled'
     AND NOT (OLD.status='pending' AND NEW.status='confirmed') THEN
    RAISE EXCEPTION 'matrix_partner_sale_confirmation_required' USING ERRCODE='23514';
  END IF;
  IF NEW.partner_transfer_status IN ('settled','received') AND EXISTS (
    SELECT 1 FROM commerce.wholesale_order_items item
     WHERE item.environment=NEW.environment AND item.order_id=NEW.id
       AND item.accepted_quantity IS NULL
  ) THEN
    RAISE EXCEPTION 'matrix_partner_arrival_unconfirmed_item' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_partner_arrival_order_guard
  ON commerce.wholesale_orders;
CREATE TRIGGER matrix_partner_arrival_order_guard
  BEFORE UPDATE OF partner_unit_id,partner_transfer_status,settled_total_amount,
    status,payment_status,paid_at,partner_payment_terms
  ON commerce.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_matrix_partner_arrival_order();

-- Reclassifica cargas abertas criadas pelas versoes 0183/0184. O livro e
-- imutavel: os lancamentos prematuros sao estornados, nunca apagados.
DO $$
DECLARE
  v_order RECORD;
  v_revenue UUID;
  v_revenue_cash_on DATE;
  v_cogs UUID;
  v_cost NUMERIC(14,2);
  v_day DATE := (current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  FOR v_order IN
    SELECT id,environment,sold_at
      FROM commerce.wholesale_orders
     WHERE partner_unit_id IS NOT NULL AND partner_transfer_status='in_transit'
     ORDER BY sold_at,id
  LOOP
    SELECT id,cash_on INTO v_revenue,v_revenue_cash_on
      FROM finance.matriz_ledger_transactions
     WHERE environment=v_order.environment
       AND source_type='commerce.wholesale_order.revenue'
       AND source_id=v_order.id::text;
    IF v_revenue IS NOT NULL THEN
      PERFORM finance.reverse_matriz_ledger_transaction(
        v_order.environment,v_revenue,
        'commerce.wholesale_order.partner_defer_revenue',v_order.id::text,v_day,
        'Receita adiada ate o acerto da chegada','migration:0187',
        CASE WHEN v_revenue_cash_on IS NULL THEN NULL ELSE v_day END,
        jsonb_build_object('order_id',v_order.id,'reason','arrival_pending')
      );
    END IF;

    SELECT id INTO v_cogs
      FROM finance.matriz_ledger_transactions
     WHERE environment=v_order.environment
       AND source_type='commerce.wholesale_order.cogs'
       AND source_id=v_order.id::text;
    IF v_cogs IS NOT NULL THEN
      PERFORM finance.reverse_matriz_ledger_transaction(
        v_order.environment,v_cogs,
        'commerce.wholesale_order.partner_defer_cogs',v_order.id::text,v_day,
        'Custo adiado ate o acerto da chegada','migration:0187',NULL,
        jsonb_build_object('order_id',v_order.id,'reason','arrival_pending')
      );
    END IF;

    -- A movimentacao fisica existe mesmo quando o livro estava desabilitado na
    -- versao que expediu a carga. Por isso o transito nao depende do COGS antigo.
    SELECT COALESCE(sum(quantity*unit_cost),0)::numeric(14,2)
      INTO v_cost FROM commerce.wholesale_order_items
     WHERE environment=v_order.environment AND order_id=v_order.id;
    IF v_cost>0 THEN
      PERFORM finance.post_matriz_ledger_transaction(
        v_order.environment,'commerce.wholesale_order.partner_dispatch',v_order.id::text,
        'inventory_in_transit_dispatch',v_cost,
        (v_order.sold_at AT TIME ZONE 'America/Sao_Paulo')::date,
        'Pneus enviados ao parceiro aguardando acerto','migration:0187',
        jsonb_build_array(
          jsonb_build_object('account_code','inventory_in_transit','account_class','asset',
            'side','debit','amount',v_cost),
          jsonb_build_object('account_code','inventory','account_class','asset',
            'side','credit','amount',v_cost)
        ),NULL,NULL,jsonb_build_object('order_id',v_order.id,'migrated',true)
      );
    END IF;
  END LOOP;
END;
$$;

SELECT set_config('app.matrix_partner_arrival','on',true);
SELECT set_config('app.matrix_partner_bridge','on',true);

UPDATE commerce.wholesale_orders
   SET status='pending',payment_status='pending',paid_at=NULL
 WHERE partner_unit_id IS NOT NULL AND partner_transfer_status='in_transit'
   AND parent_order_id IS NULL;

UPDATE commerce.wholesale_orders
   SET status='pending',payment_status='pending',paid_at=NULL
 WHERE partner_unit_id IS NOT NULL AND partner_transfer_status='in_transit'
   AND parent_order_id IS NOT NULL;

UPDATE commerce.partner_purchases purchase
   SET payment_status='payable',
       payable_due_date=COALESCE(purchase.payable_due_date,
         (purchase.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date),
       payment_method=CASE WHEN sale.partner_payment_terms='cash_on_arrival'
                           THEN 'À vista no acerto' ELSE 'A pagar à Matriz' END
  FROM commerce.wholesale_orders sale
 WHERE purchase.environment=sale.environment
   AND purchase.source_wholesale_order_id=sale.id
   AND sale.partner_transfer_status='in_transit'
   AND purchase.deleted_at IS NULL;

INSERT INTO finance.partner_payables (
  environment,unit_id,counterparty_name,description,category,amount,due_date,
  status,notes,created_by,idempotency_key,source_purchase_id
)
SELECT purchase.environment,purchase.unit_id,'Matriz 2W Pneus',
       'Compra da Matriz '||left(purchase.source_wholesale_order_id::text,8),
       'supplier',purchase.total_amount,
       COALESCE(purchase.payable_due_date,
         (purchase.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date),
       'open','Gerada pela migration 0187 para carga aguardando acerto',
       'migration:0187','purchase:'||purchase.id::text||':payable',purchase.id
  FROM commerce.partner_purchases purchase
  JOIN commerce.wholesale_orders sale
    ON sale.environment=purchase.environment
   AND sale.id=purchase.source_wholesale_order_id
 WHERE sale.partner_transfer_status='in_transit'
   AND purchase.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM finance.partner_payables payable
      WHERE payable.environment=purchase.environment
       AND payable.source_purchase_id=purchase.id AND payable.deleted_at IS NULL
   );

ALTER TABLE commerce.wholesale_orders
  VALIDATE CONSTRAINT wholesale_orders_partner_transfer_lifecycle_check;
