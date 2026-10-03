BEGIN;
-- Exceção explícita e auditável: não representa um comprovante nem cria um arquivo.
CREATE TABLE commerce.matriz_trip_lost_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  trip_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  approved_amount numeric(12,2) NOT NULL CHECK (approved_amount>0),
  expense_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  actor_admin_id uuid,
  actor_label text NOT NULL CHECK (length(btrim(actor_label)) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment,trip_id),
  UNIQUE (environment,expense_id),
  UNIQUE (environment,idempotency_key),
  FOREIGN KEY (trip_id,environment) REFERENCES commerce.matriz_delivery_trips(id,environment),
  FOREIGN KEY (expense_id,environment) REFERENCES commerce.matriz_expenses(id,environment)
);
ALTER TABLE commerce.matriz_trip_lost_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.matriz_trip_lost_receipts FROM PUBLIC,farejador_partner_app;

CREATE FUNCTION commerce.guard_matriz_lost_receipt_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $fn$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'lost_receipt_approval_immutable'; END IF;
  PERFORM 1 FROM commerce.matriz_delivery_trips t
    WHERE t.id=NEW.trip_id AND t.environment=NEW.environment
      AND t.status='closed' AND t.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trip_not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce.matriz_expenses e
    WHERE e.id=NEW.expense_id AND e.environment=NEW.environment AND e.deleted_at IS NULL
      AND e.category='combustivel' AND e.amount=NEW.approved_amount
      AND (e.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date=NEW.expense_date) THEN
    RAISE EXCEPTION 'lost_receipt_expense_conflict';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER guard_matriz_lost_receipt_approval BEFORE INSERT OR UPDATE OR DELETE
  ON commerce.matriz_trip_lost_receipts FOR EACH ROW
  EXECUTE FUNCTION commerce.guard_matriz_lost_receipt_approval();

-- Uma só régua para totais da rota, divergência e conciliação. UNION deduplica
-- a despesa se o comprovante perdido for encontrado e vinculado posteriormente.
CREATE FUNCTION commerce.matriz_trip_approved_expenses(p_trip_id uuid,p_environment env_t)
RETURNS TABLE(id uuid,amount numeric,category text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,commerce AS $fn$
  SELECT e.id,e.amount,e.category FROM commerce.matriz_expenses e
  WHERE e.environment=p_environment AND e.deleted_at IS NULL AND e.id IN (
    SELECT r.ai_expense_id FROM commerce.matriz_trip_receipts r
    WHERE r.environment=p_environment AND r.trip_id=p_trip_id
      AND r.workflow_status IN ('linked','legacy_linked')
    UNION
    SELECT a.expense_id FROM commerce.matriz_trip_lost_receipts a
    WHERE a.environment=p_environment AND a.trip_id=p_trip_id
  )
$fn$;

CREATE OR REPLACE FUNCTION commerce.matriz_trip_financial_status(p_trip_id uuid,p_environment env_t)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,commerce AS $fn$
DECLARE
  v_status text; v_fuel_spent numeric; v_confirmed_amount numeric;
  v_official_fuel numeric; v_fuel_receipts integer;
BEGIN
  SELECT t.status,COALESCE(t.fuel_spent,0),t.fuel_divergence_confirmed_amount
    INTO v_status,v_fuel_spent,v_confirmed_amount FROM commerce.matriz_delivery_trips t
    WHERE t.id=p_trip_id AND t.environment=p_environment AND t.deleted_at IS NULL;
  IF NOT FOUND OR v_status<>'closed' THEN RETURN 'pending'; END IF;
  IF EXISTS (SELECT 1 FROM commerce.matriz_trip_receipts r
    WHERE r.trip_id=p_trip_id AND r.environment=p_environment
      AND r.workflow_status IN ('uploaded','processing','review_required')) THEN RETURN 'pending'; END IF;
  IF EXISTS (SELECT 1 FROM commerce.matriz_trip_receipts r
    WHERE r.trip_id=p_trip_id AND r.environment=p_environment
      AND r.workflow_status IN ('linked','legacy_linked')
      AND (r.ai_expense_id IS NULL OR NOT EXISTS (SELECT 1 FROM commerce.matriz_expenses e
        WHERE e.id=r.ai_expense_id AND e.environment=r.environment AND e.deleted_at IS NULL))) THEN
    RETURN 'pending';
  END IF;
  IF EXISTS (SELECT 1 FROM commerce.orders o JOIN commerce.order_items oi
    ON oi.order_id=o.id AND oi.environment=o.environment
    WHERE o.trip_id=p_trip_id AND o.environment=p_environment AND o.status<>'cancelled'
      AND o.delivery_status='delivered' AND oi.matriz_unit_cost IS NULL) THEN RETURN 'pending'; END IF;
  SELECT count(*)::int,COALESCE(sum(e.amount),0) INTO v_fuel_receipts,v_official_fuel
    FROM commerce.matriz_trip_approved_expenses(p_trip_id,p_environment) e WHERE e.category='combustivel';
  IF v_fuel_spent>0 AND v_fuel_receipts=0 THEN RETURN 'pending'; END IF;
  IF v_fuel_receipts>0 AND v_official_fuel IS DISTINCT FROM v_fuel_spent
    AND v_confirmed_amount IS DISTINCT FROM v_official_fuel THEN RETURN 'divergent'; END IF;
  RETURN 'reconciled';
END $fn$;

-- A aprovação não pode perder a despesa nem mudar o valor/dia aprovado.
-- Quitar uma despesa a pagar continua permitido pelo motor financeiro normal.
CREATE FUNCTION finance.protect_matriz_lost_receipt_expense() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM commerce.matriz_trip_lost_receipts a
    WHERE a.environment=OLD.environment AND a.expense_id=OLD.id)
    AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.category IS DISTINCT FROM OLD.category OR NEW.environment IS DISTINCT FROM OLD.environment
      OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.document_date IS DISTINCT FROM OLD.document_date
      OR NEW.competence_month IS DISTINCT FROM OLD.competence_month) THEN
    RAISE EXCEPTION 'receipt_expense_locked';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER protect_matriz_lost_receipt_expense BEFORE UPDATE ON commerce.matriz_expenses
  FOR EACH ROW EXECUTE FUNCTION finance.protect_matriz_lost_receipt_expense();
REVOKE ALL ON FUNCTION commerce.guard_matriz_lost_receipt_approval(),
  commerce.matriz_trip_approved_expenses(uuid,env_t),
  commerce.matriz_trip_financial_status(uuid,env_t),finance.protect_matriz_lost_receipt_expense()
  FROM PUBLIC,farejador_partner_app;
COMMENT ON TABLE commerce.matriz_trip_lost_receipts IS
  '0260: aprovação imutável do proprietário para combustível sem comprovante; não equivale a documento fiscal.';
COMMIT;
