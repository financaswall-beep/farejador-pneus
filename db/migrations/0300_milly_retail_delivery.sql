BEGIN;

ALTER TABLE network.dot_oauth_grants
  ADD COLUMN retail_operations_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN route_operations_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE network.dot_operation_reviews DROP CONSTRAINT dot_operation_reviews_permission_domain_check,
  ADD CONSTRAINT dot_operation_reviews_permission_domain_check CHECK
    (permission_domain IN ('finance','publisher','stock','catalog','pickup','retail','route'));

ALTER TABLE commerce.matriz_delivery_trips ADD COLUMN recorded_after_delivery boolean NOT NULL DEFAULT false;
ALTER TABLE commerce.matriz_expenses ADD COLUMN delivery_trip_id uuid REFERENCES commerce.matriz_delivery_trips(id);
CREATE INDEX matriz_expenses_delivery_trip_idx ON commerce.matriz_expenses(environment,delivery_trip_id)
  WHERE delivery_trip_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX audit_retail_receipt_account_idx ON audit.events(environment,entity_id,created_at DESC,id DESC)
  WHERE event_type='retail_receipt_account_corrected';

CREATE TRIGGER matriz_expense_delivery_trip_env BEFORE INSERT OR UPDATE OF environment,delivery_trip_id ON commerce.matriz_expenses
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','matriz_delivery_trips','delivery_trip_id');

CREATE OR REPLACE FUNCTION commerce.matriz_trip_approved_expenses(p_trip_id uuid,p_environment env_t)
RETURNS TABLE(id uuid,amount numeric,category text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,commerce AS $fn$
  SELECT e.id,e.amount,e.category FROM commerce.matriz_expenses e
  WHERE e.environment=p_environment AND e.deleted_at IS NULL AND (e.delivery_trip_id=p_trip_id OR e.id IN (
    SELECT r.ai_expense_id FROM commerce.matriz_trip_receipts r
    WHERE r.environment=p_environment AND r.trip_id=p_trip_id
      AND r.workflow_status IN ('linked','legacy_linked')
    UNION
    SELECT a.expense_id FROM commerce.matriz_trip_lost_receipts a
    WHERE a.environment=p_environment AND a.trip_id=p_trip_id
  ))
$fn$;

COMMIT;
