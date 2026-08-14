-- 0170_partner_payroll_commission_bridge.sql
-- Converge o fechamento de comissao do parceiro para o mesmo principio da
-- Matriz: a comissao e uma rubrica imutavel da remuneracao/folha. O payable
-- continua sendo o instrumento de liquidacao e a unica origem da saida de caixa.

CREATE TABLE IF NOT EXISTS finance.partner_payroll_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  partner_unit_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  competence_month DATE NOT NULL
    CHECK (competence_month=date_trunc('month',competence_month)::date),
  closed_at TIMESTAMPTZ NOT NULL,
  closed_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_payroll_periods_uniq
    UNIQUE (environment,partner_unit_id,competence_month),
  CONSTRAINT partner_payroll_periods_unit_fk
    FOREIGN KEY (environment,partner_unit_id)
    REFERENCES network.partner_units(environment,id),
  CONSTRAINT partner_payroll_periods_core_unit_fk
    FOREIGN KEY (environment,unit_id)
    REFERENCES core.units(environment,id)
);

CREATE TABLE IF NOT EXISTS finance.partner_payroll_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  payroll_period_id UUID NOT NULL REFERENCES finance.partner_payroll_periods(id),
  commission_period_id UUID NOT NULL
    REFERENCES finance.partner_staff_commission_periods(id),
  token_id UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  base_salary NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (base_salary>=0),
  benefits NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (benefits>=0),
  commission_amount NUMERIC(14,2) NOT NULL CHECK (commission_amount>=0),
  additions NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (additions>=0),
  deductions NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (deductions>=0),
  total_due NUMERIC(14,2) NOT NULL CHECK (total_due>=0),
  payable_id UUID REFERENCES finance.partner_payables(id),
  calculation JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_payroll_items_commission_period_uniq
    UNIQUE (environment,commission_period_id),
  CONSTRAINT partner_payroll_items_person_uniq
    UNIQUE (environment,payroll_period_id,token_id),
  CHECK ((total_due=0 AND payable_id IS NULL) OR (total_due>0 AND payable_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS partner_payroll_items_token_idx
  ON finance.partner_payroll_items(environment,token_id,payroll_period_id);

CREATE OR REPLACE FUNCTION finance.sync_partner_commission_to_payroll()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE
  v_payroll_period_id UUID;
BEGIN
  INSERT INTO finance.partner_payroll_periods
    (environment,partner_unit_id,unit_id,competence_month,closed_at,closed_by)
  VALUES
    (NEW.environment,NEW.partner_unit_id,NEW.unit_id,NEW.competence_month,
     NEW.closed_at,NEW.closed_by)
  ON CONFLICT (environment,partner_unit_id,competence_month)
  DO NOTHING;

  SELECT id INTO v_payroll_period_id
    FROM finance.partner_payroll_periods
   WHERE environment=NEW.environment
     AND partner_unit_id=NEW.partner_unit_id
     AND competence_month=NEW.competence_month;

  INSERT INTO finance.partner_payroll_items
    (environment,payroll_period_id,commission_period_id,token_id,
     commission_amount,total_due,payable_id,calculation)
  VALUES
    (NEW.environment,v_payroll_period_id,NEW.id,NEW.token_id,
     NEW.payable_amount,NEW.payable_amount,NEW.payable_id,
     jsonb_build_object(
       'source','partner_staff_commission_periods',
       'sales_count',NEW.sales_count,
       'gross_sales',NEW.gross_sales,
       'earned_amount',NEW.earned_amount,
       'adjustment_amount',NEW.adjustment_amount
     ))
  ON CONFLICT (environment,commission_period_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_commission_period_to_payroll
  ON finance.partner_staff_commission_periods;
CREATE TRIGGER partner_commission_period_to_payroll
AFTER INSERT ON finance.partner_staff_commission_periods
FOR EACH ROW EXECUTE FUNCTION finance.sync_partner_commission_to_payroll();

-- Compatibilidade com fechamentos existentes: nenhum pagamento e recriado.
INSERT INTO finance.partner_payroll_periods
  (environment,partner_unit_id,unit_id,competence_month,closed_at,closed_by)
SELECT environment,partner_unit_id,unit_id,competence_month,
       min(closed_at),min(closed_by)
  FROM finance.partner_staff_commission_periods
 GROUP BY environment,partner_unit_id,unit_id,competence_month
ON CONFLICT (environment,partner_unit_id,competence_month) DO NOTHING;

INSERT INTO finance.partner_payroll_items
  (environment,payroll_period_id,commission_period_id,token_id,
   commission_amount,total_due,payable_id,calculation)
SELECT period.environment,payroll.id,period.id,period.token_id,
       period.payable_amount,period.payable_amount,period.payable_id,
       jsonb_build_object(
         'source','partner_staff_commission_periods',
         'sales_count',period.sales_count,
         'gross_sales',period.gross_sales,
         'earned_amount',period.earned_amount,
         'adjustment_amount',period.adjustment_amount
       )
  FROM finance.partner_staff_commission_periods period
  JOIN finance.partner_payroll_periods payroll
    ON payroll.environment=period.environment
   AND payroll.partner_unit_id=period.partner_unit_id
   AND payroll.competence_month=period.competence_month
ON CONFLICT (environment,commission_period_id) DO NOTHING;

CREATE OR REPLACE FUNCTION finance.guard_partner_payroll_fact()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'partner_payroll_fact_immutable';
END;
$function$;

DROP TRIGGER IF EXISTS partner_payroll_periods_immutable
  ON finance.partner_payroll_periods;
CREATE TRIGGER partner_payroll_periods_immutable
BEFORE UPDATE OR DELETE ON finance.partner_payroll_periods
FOR EACH ROW EXECUTE FUNCTION finance.guard_partner_payroll_fact();

DROP TRIGGER IF EXISTS partner_payroll_items_immutable
  ON finance.partner_payroll_items;
CREATE TRIGGER partner_payroll_items_immutable
BEFORE UPDATE OR DELETE ON finance.partner_payroll_items
FOR EACH ROW EXECUTE FUNCTION finance.guard_partner_payroll_fact();

ALTER TABLE finance.partner_payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.partner_payroll_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_payroll_periods_isolation
  ON finance.partner_payroll_periods;
CREATE POLICY partner_payroll_periods_isolation
  ON finance.partner_payroll_periods FOR SELECT
  USING (unit_id=network.current_partner_core_unit());

DROP POLICY IF EXISTS partner_payroll_items_isolation
  ON finance.partner_payroll_items;
CREATE POLICY partner_payroll_items_isolation
  ON finance.partner_payroll_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM finance.partner_payroll_periods period
     WHERE period.id=payroll_period_id
       AND period.environment=partner_payroll_items.environment
       AND period.unit_id=network.current_partner_core_unit()
  ));

REVOKE ALL ON finance.partner_payroll_periods FROM PUBLIC;
REVOKE ALL ON finance.partner_payroll_items FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.sync_partner_commission_to_payroll() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_partner_payroll_fact() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    GRANT SELECT ON finance.partner_payroll_periods TO farejador_partner_app;
    GRANT SELECT ON finance.partner_payroll_items TO farejador_partner_app;
  END IF;
END;
$grants$;

DO $assertions$
BEGIN
  IF EXISTS (
    SELECT 1 FROM finance.partner_staff_commission_periods source
     LEFT JOIN finance.partner_payroll_items item
       ON item.environment=source.environment
      AND item.commission_period_id=source.id
    WHERE item.id IS NULL
  ) THEN RAISE EXCEPTION 'partner_payroll_backfill_incomplete'; END IF;
  IF EXISTS (
    SELECT 1 FROM finance.partner_payroll_items
     WHERE total_due<>base_salary+benefits+commission_amount+additions-deductions
  ) THEN RAISE EXCEPTION 'partner_payroll_total_invalid'; END IF;
END;
$assertions$;

COMMENT ON TABLE finance.partner_payroll_periods IS
  'Fechamento mensal da remuneracao dos colaboradores do parceiro.';
COMMENT ON TABLE finance.partner_payroll_items IS
  'Rubricas congeladas da remuneracao do parceiro; a comissao integra a folha e o payable liquida a saida uma unica vez.';
