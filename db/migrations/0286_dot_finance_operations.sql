BEGIN;
ALTER TABLE network.dot_oauth_grants
  ADD COLUMN finance_operations_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE commerce.wholesale_orders
  ADD COLUMN installment_agreement jsonb CHECK (jsonb_typeof(installment_agreement)='array');
-- O evento compensatório conserva o pagamento original e reabre o saldo espelhado.
ALTER TABLE finance.partner_payable_events
  ADD COLUMN reversal_of uuid REFERENCES finance.partner_payable_events(id),
  DROP CONSTRAINT partner_payable_events_amount_check,
  ADD CHECK ((reversal_of IS NULL AND amount>0) OR (reversal_of IS NOT NULL AND amount<0)),
  ADD UNIQUE (environment,reversal_of);

CREATE FUNCTION finance.guard_matrix_payable_correction() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finance AS $fn$
BEGIN
  IF session_user='farejador_partner_app' OR current_setting('app.matrix_partner_bridge',true) IS DISTINCT FROM 'on'
     OR NOT EXISTS (SELECT 1 FROM finance.partner_payable_events original
       WHERE original.id=NEW.reversal_of AND original.environment=NEW.environment AND original.unit_id=NEW.unit_id
       AND original.payable_id=NEW.payable_id AND original.reversal_of IS NULL AND original.amount=-NEW.amount
       AND original.paid_at<=NEW.paid_at) THEN
    RAISE EXCEPTION 'matrix_payable_correction_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER matrix_payable_correction_guard BEFORE INSERT ON finance.partner_payable_events
  FOR EACH ROW WHEN (NEW.reversal_of IS NOT NULL) EXECUTE FUNCTION finance.guard_matrix_payable_correction();
COMMIT;
