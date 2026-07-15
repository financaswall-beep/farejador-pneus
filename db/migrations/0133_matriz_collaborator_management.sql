-- 0133 — Gestão de colaboradores da Matriz: cargo flexível, remuneração,
-- comissão, folha e atribuição operacional. A folha é conciliada com
-- commerce.matriz_expenses: competência nasce ao fechar; caixa sai ao pagar.

ALTER TABLE network.matriz_collaborators
  DROP CONSTRAINT IF EXISTS matriz_collaborators_job_check;
ALTER TABLE network.matriz_collaborators
  ADD CONSTRAINT matriz_collaborators_job_check
  CHECK (job IN ('vendedor', 'entregador', 'colaborador'));

ALTER TABLE network.matriz_collaborators
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  ADD COLUMN IF NOT EXISTS work_area TEXT;

UPDATE network.matriz_collaborators
   SET job_title = CASE job WHEN 'vendedor' THEN 'Vendedor' WHEN 'entregador' THEN 'Entregador' ELSE 'Colaborador' END,
       work_area = CASE job WHEN 'vendedor' THEN 'sales' WHEN 'entregador' THEN 'delivery' ELSE 'other' END
 WHERE job_title IS NULL OR work_area IS NULL;

ALTER TABLE network.matriz_collaborators
  ALTER COLUMN job_title SET NOT NULL,
  ALTER COLUMN work_area SET NOT NULL;

ALTER TABLE network.matriz_collaborators
  ADD CONSTRAINT matriz_collaborators_job_title_check
    CHECK (length(btrim(job_title)) BETWEEN 2 AND 60),
  ADD CONSTRAINT matriz_collaborators_work_area_check
    CHECK (work_area IN ('sales', 'delivery', 'administrative', 'workshop', 'other'));

CREATE TABLE IF NOT EXISTS network.matriz_collaborator_compensation (
  collaborator_id UUID PRIMARY KEY REFERENCES network.matriz_collaborators(id),
  environment env_t NOT NULL,
  employment_type TEXT NOT NULL CHECK (employment_type IN ('clt', 'mei', 'autonomo', 'outro')),
  base_salary NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  payment_day SMALLINT NOT NULL DEFAULT 5 CHECK (payment_day BETWEEN 1 AND 28),
  payment_method TEXT NOT NULL DEFAULT 'pix' CHECK (payment_method IN ('pix', 'transferencia', 'dinheiro', 'outro')),
  payment_note TEXT CHECK (payment_note IS NULL OR length(payment_note) <= 160),
  starts_on DATE NOT NULL DEFAULT current_date,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS network.matriz_collaborator_commission_rules (
  collaborator_id UUID PRIMARY KEY REFERENCES network.matriz_collaborators(id),
  environment env_t NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
  basis TEXT NOT NULL CHECK (basis IN ('margin', 'revenue', 'sale', 'delivery', 'trip')),
  value NUMERIC(12,2) NOT NULL CHECK (value >= 0),
  starts_on DATE NOT NULL DEFAULT current_date,
  active BOOLEAN NOT NULL DEFAULT true,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'percent' AND basis IN ('margin', 'revenue') AND value <= 100)
      OR (kind = 'fixed' AND basis IN ('sale', 'delivery', 'trip')))
);

CREATE TABLE IF NOT EXISTS finance.matriz_payroll_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  collaborator_id UUID NOT NULL REFERENCES network.matriz_collaborators(id),
  competence DATE NOT NULL CHECK (competence = date_trunc('month', competence)::date),
  kind TEXT NOT NULL CHECK (kind IN ('addition', 'deduction')),
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 2 AND 120),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS finance.matriz_payroll_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  competence DATE NOT NULL CHECK (competence = date_trunc('month', competence)::date),
  status TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('closed', 'partial', 'paid')),
  closed_by TEXT,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, competence)
);

CREATE TABLE IF NOT EXISTS finance.matriz_payroll_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  payroll_period_id UUID NOT NULL REFERENCES finance.matriz_payroll_periods(id),
  collaborator_id UUID NOT NULL REFERENCES network.matriz_collaborators(id),
  job_title TEXT NOT NULL,
  employment_type TEXT,
  base_salary NUMERIC(12,2) NOT NULL CHECK (base_salary >= 0),
  commission_amount NUMERIC(12,2) NOT NULL CHECK (commission_amount >= 0),
  additions NUMERIC(12,2) NOT NULL CHECK (additions >= 0),
  deductions NUMERIC(12,2) NOT NULL CHECK (deductions >= 0),
  total_due NUMERIC(12,2) NOT NULL CHECK (total_due >= 0),
  due_date DATE,
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid')),
  paid_at TIMESTAMPTZ,
  paid_by TEXT,
  source_expense_id UUID UNIQUE REFERENCES commerce.matriz_expenses(id),
  calculation JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_period_id, collaborator_id)
);

ALTER TABLE commerce.orders
  ADD COLUMN IF NOT EXISTS seller_collaborator_id UUID REFERENCES network.matriz_collaborators(id);
ALTER TABLE commerce.wholesale_orders
  ADD COLUMN IF NOT EXISTS seller_collaborator_id UUID REFERENCES network.matriz_collaborators(id);

CREATE INDEX IF NOT EXISTS matriz_payroll_adjustments_lookup_idx
  ON finance.matriz_payroll_adjustments (environment, competence, collaborator_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS matriz_payroll_items_status_idx
  ON finance.matriz_payroll_items (environment, payment_status, due_date);
CREATE INDEX IF NOT EXISTS matriz_orders_seller_idx
  ON commerce.orders (environment, seller_collaborator_id, created_at)
  WHERE seller_collaborator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS matriz_wholesale_seller_idx
  ON commerce.wholesale_orders (environment, seller_collaborator_id, created_at)
  WHERE seller_collaborator_id IS NOT NULL;

DROP TRIGGER IF EXISTS env_match_matriz_comp_collab ON network.matriz_collaborator_compensation;
CREATE TRIGGER env_match_matriz_comp_collab BEFORE INSERT OR UPDATE OF collaborator_id
  ON network.matriz_collaborator_compensation FOR EACH ROW
  EXECUTE FUNCTION ops.validate_env_match('network', 'matriz_collaborators', 'collaborator_id');
DROP TRIGGER IF EXISTS env_match_matriz_commission_collab ON network.matriz_collaborator_commission_rules;
CREATE TRIGGER env_match_matriz_commission_collab BEFORE INSERT OR UPDATE OF collaborator_id
  ON network.matriz_collaborator_commission_rules FOR EACH ROW
  EXECUTE FUNCTION ops.validate_env_match('network', 'matriz_collaborators', 'collaborator_id');
DROP TRIGGER IF EXISTS env_match_matriz_adjustment_collab ON finance.matriz_payroll_adjustments;
CREATE TRIGGER env_match_matriz_adjustment_collab BEFORE INSERT OR UPDATE OF collaborator_id
  ON finance.matriz_payroll_adjustments FOR EACH ROW
  EXECUTE FUNCTION ops.validate_env_match('network', 'matriz_collaborators', 'collaborator_id');
DROP TRIGGER IF EXISTS env_match_matriz_payroll_item_collab ON finance.matriz_payroll_items;
CREATE TRIGGER env_match_matriz_payroll_item_collab BEFORE INSERT OR UPDATE OF collaborator_id
  ON finance.matriz_payroll_items FOR EACH ROW
  EXECUTE FUNCTION ops.validate_env_match('network', 'matriz_collaborators', 'collaborator_id');
DROP TRIGGER IF EXISTS env_match_order_seller_collab ON commerce.orders;
CREATE TRIGGER env_match_order_seller_collab BEFORE INSERT OR UPDATE OF seller_collaborator_id
  ON commerce.orders FOR EACH ROW
  EXECUTE FUNCTION ops.validate_env_match('network', 'matriz_collaborators', 'seller_collaborator_id');
DROP TRIGGER IF EXISTS env_match_wholesale_seller_collab ON commerce.wholesale_orders;
CREATE TRIGGER env_match_wholesale_seller_collab BEFORE INSERT OR UPDATE OF seller_collaborator_id
  ON commerce.wholesale_orders FOR EACH ROW
  EXECUTE FUNCTION ops.validate_env_match('network', 'matriz_collaborators', 'seller_collaborator_id');

CREATE OR REPLACE FUNCTION finance.sync_matriz_payroll_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, finance, commerce AS $$
BEGIN
  IF NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid' THEN
    UPDATE finance.matriz_payroll_items
       SET payment_status = 'paid', paid_at = COALESCE(NEW.paid_at, now()), paid_by = COALESCE(paid_by, 'financeiro-matriz')
     WHERE source_expense_id = NEW.id AND payment_status = 'pending';
    UPDATE finance.matriz_payroll_periods p
       SET status = CASE
         WHEN NOT EXISTS (SELECT 1 FROM finance.matriz_payroll_items i WHERE i.payroll_period_id = p.id AND i.payment_status = 'pending') THEN 'paid'
         ELSE 'partial' END
     WHERE EXISTS (SELECT 1 FROM finance.matriz_payroll_items i WHERE i.payroll_period_id = p.id AND i.source_expense_id = NEW.id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sync_matriz_payroll_payment ON commerce.matriz_expenses;
CREATE TRIGGER sync_matriz_payroll_payment AFTER UPDATE OF payment_status ON commerce.matriz_expenses
  FOR EACH ROW EXECUTE FUNCTION finance.sync_matriz_payroll_payment();

CREATE OR REPLACE FUNCTION finance.protect_matriz_payroll_expense()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, finance AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM finance.matriz_payroll_items WHERE source_expense_id = NEW.id) THEN
    RAISE EXCEPTION 'payroll_expense_locked';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protect_matriz_payroll_expense ON commerce.matriz_expenses;
CREATE TRIGGER protect_matriz_payroll_expense BEFORE UPDATE OF deleted_at ON commerce.matriz_expenses
  FOR EACH ROW EXECUTE FUNCTION finance.protect_matriz_payroll_expense();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    REVOKE ALL ON network.matriz_collaborator_compensation FROM farejador_partner_app;
    REVOKE ALL ON network.matriz_collaborator_commission_rules FROM farejador_partner_app;
    REVOKE ALL ON finance.matriz_payroll_adjustments FROM farejador_partner_app;
    REVOKE ALL ON finance.matriz_payroll_periods FROM farejador_partner_app;
    REVOKE ALL ON finance.matriz_payroll_items FROM farejador_partner_app;
  END IF;
END $$;
