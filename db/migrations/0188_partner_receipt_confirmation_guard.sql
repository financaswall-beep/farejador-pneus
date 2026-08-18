-- 0188 - Permite ao parceiro concluir somente o recebimento ja acertado pela Matriz.
--
-- A 0184 faz o recebimento espelhado mudar a carga de settled para received.
-- A protecao da 0187, corretamente, bloqueia o parceiro de simular o acerto da
-- Matriz, mas tambem bloqueava essa ultima transicao legitima. A excecao abaixo
-- e estreita: mesma unidade autenticada, compra vinculada ja recebida, itens
-- identicos ao acerto e nenhum campo comercial/financeiro alterado.

CREATE OR REPLACE FUNCTION commerce.guard_matrix_partner_arrival_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,commerce,network
AS $$
DECLARE
  v_arrival_allowed BOOLEAN :=
    COALESCE(current_setting('app.matrix_partner_arrival',true),'')='on'
    AND session_user<>'farejador_partner_app';
  v_partner_receipt_allowed BOOLEAN := false;
BEGIN
  IF OLD.partner_unit_id IS NULL AND NEW.partner_unit_id IS NULL THEN RETURN NEW; END IF;

  IF session_user='farejador_partner_app'
     AND COALESCE(current_setting('app.partner_unit_id',true),'')=NEW.partner_unit_id::text
     AND OLD.partner_transfer_status='settled'
     AND NEW.partner_transfer_status='received'
     AND ROW(
       NEW.partner_unit_id,NEW.settled_total_amount,NEW.status,
       NEW.payment_status,NEW.paid_at,NEW.partner_payment_terms
     ) IS NOT DISTINCT FROM ROW(
       OLD.partner_unit_id,OLD.settled_total_amount,OLD.status,
       OLD.payment_status,OLD.paid_at,OLD.partner_payment_terms
     )
     AND EXISTS (
       SELECT 1
         FROM commerce.partner_purchases purchase
         JOIN network.partner_units partner_unit
           ON partner_unit.environment=purchase.environment
          AND partner_unit.unit_id=purchase.unit_id
        WHERE purchase.environment=NEW.environment
          AND purchase.source_wholesale_order_id=NEW.id
          AND purchase.receipt_status='received'
          AND purchase.deleted_at IS NULL
          AND partner_unit.id=NEW.partner_unit_id
          AND partner_unit.status='active'
          AND partner_unit.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM commerce.partner_purchase_items item
             WHERE item.environment=purchase.environment
               AND item.purchase_id=purchase.id
               AND item.received_quantity IS DISTINCT FROM item.confirmed_quantity
          )
     ) THEN
    v_partner_receipt_allowed := true;
  END IF;

  IF NEW.partner_payment_terms IS DISTINCT FROM OLD.partner_payment_terms THEN
    RAISE EXCEPTION 'matrix_partner_payment_terms_immutable' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.partner_unit_id,NEW.partner_transfer_status,NEW.settled_total_amount)
     IS DISTINCT FROM
     ROW(OLD.partner_unit_id,OLD.partner_transfer_status,OLD.settled_total_amount)
     AND NOT (v_arrival_allowed OR v_partner_receipt_allowed) THEN
    RAISE EXCEPTION 'matrix_partner_arrival_operation_required' USING ERRCODE='23514';
  END IF;
  IF OLD.partner_transfer_status='in_transit'
     AND ROW(NEW.status,NEW.payment_status,NEW.paid_at)
       IS DISTINCT FROM ROW(OLD.status,OLD.payment_status,OLD.paid_at)
     AND NOT v_arrival_allowed THEN
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

COMMENT ON FUNCTION commerce.guard_matrix_partner_arrival_order() IS
  '0188: protege o acerto da Matriz e permite ao parceiro apenas concluir um recebimento vinculado e matematicamente identico.';

DO $smoke$
BEGIN
  IF to_regprocedure('commerce.guard_matrix_partner_arrival_order()') IS NULL THEN
    RAISE EXCEPTION '0188: guard de recebimento do parceiro ausente';
  END IF;
END;
$smoke$;
