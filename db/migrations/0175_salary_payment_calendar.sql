-- 0175 - Calendario de pagamento do salario.
-- O valor semanal e informado de forma exata (nao e salario mensal dividido por 4).
-- Beneficios permanecem mensais e comissao conserva seu calendario independente.

ALTER TABLE network.matriz_collaborator_compensation
  ADD COLUMN IF NOT EXISTS salary_frequency TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE network.matriz_collaborator_compensation
  DROP CONSTRAINT IF EXISTS matriz_salary_frequency_check;
ALTER TABLE network.matriz_collaborator_compensation
  ADD CONSTRAINT matriz_salary_frequency_check
  CHECK (salary_frequency IN ('weekly','monthly'));

ALTER TABLE network.partner_collaborator_compensation
  ADD COLUMN IF NOT EXISTS salary_frequency TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE network.partner_collaborator_compensation
  DROP CONSTRAINT IF EXISTS partner_salary_frequency_check;
ALTER TABLE network.partner_collaborator_compensation
  ADD CONSTRAINT partner_salary_frequency_check
  CHECK (salary_frequency IN ('weekly','monthly'));

CREATE TABLE IF NOT EXISTS finance.partner_staff_salary_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  partner_unit_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  token_id UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  period_start DATE NOT NULL CHECK (extract(dow FROM period_start)=0),
  period_end DATE NOT NULL CHECK (period_end=period_start+6),
  salary_amount NUMERIC(14,2) NOT NULL CHECK (salary_amount>0),
  payable_id UUID NOT NULL UNIQUE REFERENCES finance.partner_payables(id),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by TEXT NOT NULL DEFAULT 'system:weekly-salary-rollover',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_staff_salary_unit_fk FOREIGN KEY (environment,partner_unit_id)
    REFERENCES network.partner_units(environment,id),
  CONSTRAINT partner_staff_salary_core_unit_fk FOREIGN KEY (environment,unit_id)
    REFERENCES core.units(environment,id),
  UNIQUE (environment,token_id,period_start)
);
CREATE INDEX IF NOT EXISTS partner_staff_salary_period_idx
  ON finance.partner_staff_salary_periods(environment,unit_id,period_start DESC);

CREATE TABLE IF NOT EXISTS finance.matriz_salary_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  collaborator_id UUID NOT NULL REFERENCES network.matriz_collaborators(id),
  period_start DATE NOT NULL CHECK (extract(dow FROM period_start)=0),
  period_end DATE NOT NULL CHECK (period_end=period_start+6),
  salary_amount NUMERIC(14,2) NOT NULL CHECK (salary_amount>0),
  source_expense_id UUID NOT NULL UNIQUE REFERENCES commerce.matriz_expenses(id),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid')),
  paid_at TIMESTAMPTZ,
  paid_by TEXT,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by TEXT NOT NULL DEFAULT 'system:weekly-salary-rollover',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment,collaborator_id,period_start),
  CHECK ((payment_status='pending' AND paid_at IS NULL)
      OR (payment_status='paid' AND paid_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS matriz_salary_period_status_idx
  ON finance.matriz_salary_periods(environment,payment_status,period_start DESC);

CREATE OR REPLACE FUNCTION finance.guard_partner_staff_commission_payable()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM finance.partner_staff_commission_periods p WHERE p.payable_id=OLD.id)
     AND NOT EXISTS (SELECT 1 FROM finance.partner_staff_salary_periods p WHERE p.payable_id=OLD.id) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'partner_staff_commission_payable_immutable'; END IF;
  IF ROW(NEW.environment,NEW.unit_id,NEW.counterparty_name,NEW.description,
         NEW.category,NEW.amount,NEW.due_date,NEW.idempotency_key,
         NEW.competence_month,NEW.deleted_at)
     IS DISTINCT FROM
     ROW(OLD.environment,OLD.unit_id,OLD.counterparty_name,OLD.description,
         OLD.category,OLD.amount,OLD.due_date,OLD.idempotency_key,
         OLD.competence_month,OLD.deleted_at) THEN
    RAISE EXCEPTION 'partner_staff_commission_payable_immutable';
  END IF;
  IF OLD.status='open' AND NEW.status='paid' THEN RETURN NEW; END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'partner_staff_commission_payable_immutable';
END;
$function$;

CREATE OR REPLACE FUNCTION finance.guard_partner_staff_salary_period()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'partner_staff_salary_period_immutable';
END;
$function$;
DROP TRIGGER IF EXISTS partner_staff_salary_period_immutable
  ON finance.partner_staff_salary_periods;
CREATE TRIGGER partner_staff_salary_period_immutable
BEFORE UPDATE OR DELETE ON finance.partner_staff_salary_periods
FOR EACH ROW EXECUTE FUNCTION finance.guard_partner_staff_salary_period();

CREATE OR REPLACE FUNCTION finance.guard_matriz_salary_period()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'matriz_salary_period_immutable'; END IF;
  IF ROW(NEW.environment,NEW.collaborator_id,NEW.period_start,NEW.period_end,
         NEW.salary_amount,NEW.source_expense_id,NEW.closed_at,NEW.closed_by,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.environment,OLD.collaborator_id,OLD.period_start,OLD.period_end,
         OLD.salary_amount,OLD.source_expense_id,OLD.closed_at,OLD.closed_by,OLD.created_at)
  THEN RAISE EXCEPTION 'matriz_salary_period_immutable'; END IF;
  IF OLD.payment_status='pending' AND NEW.payment_status='paid'
     AND OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL
     AND OLD.paid_by IS NULL AND NEW.paid_by IS NOT NULL THEN RETURN NEW; END IF;
  IF ROW(NEW.payment_status,NEW.paid_at,NEW.paid_by)
     IS NOT DISTINCT FROM ROW(OLD.payment_status,OLD.paid_at,OLD.paid_by) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'matriz_salary_period_immutable';
END;
$function$;
DROP TRIGGER IF EXISTS matriz_salary_period_immutable ON finance.matriz_salary_periods;
CREATE TRIGGER matriz_salary_period_immutable
BEFORE UPDATE OR DELETE ON finance.matriz_salary_periods
FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_salary_period();

CREATE OR REPLACE FUNCTION finance.run_partner_staff_salary_rollover(
  p_environment env_t,p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  v_today DATE:=(p_now AT TIME ZONE 'America/Sao_Paulo')::date;
  v_row RECORD; v_payable_id UUID; v_created INTEGER:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('partner-staff-salary:'||p_environment::text));
  FOR v_row IN
    SELECT pat.id token_id,pat.partner_unit_id,pu.unit_id,
           week_start::date period_start,(week_start::date+6) period_end,
           cfg.base_salary salary_amount,
           COALESCE(NULLIF(btrim(pat.label),''),NULLIF(btrim(pat.login_username),''),'Funcionario') counterparty
      FROM network.partner_access_tokens pat
      JOIN network.partner_units pu ON pu.environment=pat.environment AND pu.id=pat.partner_unit_id
      CROSS JOIN LATERAL generate_series(
        (SELECT min(c.starts_on)-extract(dow FROM min(c.starts_on))::int
           FROM network.partner_collaborator_compensation c
          WHERE c.environment=pat.environment AND c.token_id=pat.id),
        v_today,interval '1 week') week_start
      JOIN LATERAL (
        SELECT c.base_salary,c.salary_frequency
          FROM network.partner_collaborator_compensation c
         WHERE c.environment=pat.environment AND c.token_id=pat.id
           AND c.starts_on<=week_start::date
         ORDER BY c.starts_on DESC LIMIT 1
      ) cfg ON true
     WHERE pat.environment=p_environment AND pat.role='funcionario'
       AND cfg.salary_frequency='weekly' AND cfg.base_salary>0
       AND week_start::date+6<v_today
       AND pat.created_at<(week_start::date+7)
       AND (pat.revoked_at IS NULL OR pat.revoked_at>=week_start::date)
       AND NOT EXISTS (SELECT 1 FROM finance.partner_staff_salary_periods period
         WHERE period.environment=p_environment AND period.token_id=pat.id
           AND period.period_start=week_start::date)
     ORDER BY week_start,pat.id
  LOOP
    INSERT INTO finance.partner_payables
      (environment,unit_id,counterparty_name,description,category,amount,due_date,
       status,notes,idempotency_key,created_by,competence_month)
    VALUES (p_environment,v_row.unit_id,v_row.counterparty,
      'Salario semanal - '||to_char(v_row.period_start,'DD/MM')||' a '||to_char(v_row.period_end,'DD/MM/YYYY'),
      'employee',v_row.salary_amount,v_row.period_end+1,'open',
      'Valor semanal exato definido na remuneracao. Beneficios permanecem mensais.',
      'staff-salary-weekly:'||v_row.token_id::text||':'||v_row.period_start::text,
      'system:weekly-salary-rollover',date_trunc('month',v_row.period_end)::date)
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
    DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id INTO v_payable_id;
    INSERT INTO finance.partner_staff_salary_periods
      (environment,partner_unit_id,unit_id,token_id,period_start,period_end,
       salary_amount,payable_id,closed_at)
    VALUES (p_environment,v_row.partner_unit_id,v_row.unit_id,v_row.token_id,
      v_row.period_start,v_row.period_end,v_row.salary_amount,v_payable_id,p_now)
    ON CONFLICT (environment,token_id,period_start) DO NOTHING;
    IF FOUND THEN v_created:=v_created+1; END IF;
  END LOOP;
  RETURN jsonb_build_object('environment',p_environment,'current_month',date_trunc('month',v_today)::date,
    'periods_closed',v_created,'payables_created',v_created);
END;
$function$;

-- A folha mensal ignora o salario quando a regra vigente e semanal. Beneficios
-- e comissao mensal continuam convergindo na mesma conta mensal.
CREATE OR REPLACE FUNCTION finance.prepare_partner_payroll_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  v_comp RECORD; v_salary NUMERIC(14,2):=0; v_benefits NUMERIC(14,2):=0;
  v_commission NUMERIC(14,2):=0; v_total NUMERIC(14,2):=0; v_counterparty TEXT; v_due DATE;
BEGIN
  IF NEW.settlement_frequency='weekly' THEN RETURN NEW; END IF;
  SELECT c.* INTO v_comp FROM network.partner_collaborator_compensation c
   WHERE c.environment=NEW.environment AND c.token_id=NEW.token_id
     AND c.starts_on<(NEW.competence_month+interval '1 month')::date
   ORDER BY c.starts_on DESC LIMIT 1;
  IF v_comp.id IS NOT NULL THEN
    v_salary:=CASE WHEN v_comp.salary_frequency='weekly' THEN 0 ELSE v_comp.base_salary END;
    SELECT COALESCE(sum((item->>'amount')::numeric)
      FILTER (WHERE COALESCE((item->>'active')::boolean,true)),0)::numeric(14,2)
      INTO v_benefits FROM jsonb_array_elements(v_comp.benefits) item;
  END IF;
  v_commission:=round(GREATEST(NEW.earned_amount+NEW.adjustment_amount,0),2);
  v_total:=round(v_salary+v_benefits+v_commission,2);
  v_due:=(NEW.competence_month+interval '1 month'
    +(LEAST(COALESCE(v_comp.payment_day,5),28)-1)*interval '1 day')::date;
  SELECT COALESCE(NULLIF(btrim(pat.label),''),NULLIF(btrim(pat.login_username),''),'Funcionario')
    INTO v_counterparty FROM network.partner_access_tokens pat
   WHERE pat.environment=NEW.environment AND pat.id=NEW.token_id;
  IF v_total>0 AND NEW.payable_id IS NOT NULL THEN
    UPDATE finance.partner_payables SET amount=v_total,
      description='Folha da equipe - '||to_char(NEW.competence_month,'MM/YYYY'),due_date=v_due,
      notes='Salario mensal, beneficios e comissao mensal em um unico fechamento.'
     WHERE environment=NEW.environment AND id=NEW.payable_id;
  ELSIF v_total>0 THEN
    INSERT INTO finance.partner_payables
      (environment,unit_id,counterparty_name,description,category,amount,due_date,
       status,notes,idempotency_key,created_by,competence_month)
    VALUES (NEW.environment,NEW.unit_id,v_counterparty,
      'Folha da equipe - '||to_char(NEW.competence_month,'MM/YYYY'),'employee',v_total,v_due,'open',
      'Salario mensal, beneficios e comissao mensal em um unico fechamento.',
      'staff-payroll:'||NEW.token_id::text||':'||to_char(NEW.competence_month,'YYYY-MM'),
      'system:monthly-rollover',NEW.competence_month)
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
    DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id INTO NEW.payable_id;
  ELSE NEW.payable_id:=NULL; END IF;
  NEW.payable_amount:=v_total;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION finance.sync_partner_commission_to_payroll()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  v_payroll_period_id UUID; v_comp RECORD; v_salary NUMERIC(14,2):=0;
  v_benefits NUMERIC(14,2):=0; v_commission NUMERIC(14,2):=0;
BEGIN
  IF NEW.settlement_frequency='weekly' THEN RETURN NEW; END IF;
  SELECT c.* INTO v_comp FROM network.partner_collaborator_compensation c
   WHERE c.environment=NEW.environment AND c.token_id=NEW.token_id
     AND c.starts_on<(NEW.competence_month+interval '1 month')::date
   ORDER BY c.starts_on DESC LIMIT 1;
  IF v_comp.id IS NOT NULL THEN
    v_salary:=CASE WHEN v_comp.salary_frequency='weekly' THEN 0 ELSE v_comp.base_salary END;
    SELECT COALESCE(sum((item->>'amount')::numeric)
      FILTER (WHERE COALESCE((item->>'active')::boolean,true)),0)::numeric(14,2)
      INTO v_benefits FROM jsonb_array_elements(v_comp.benefits) item;
  END IF;
  v_commission:=round(GREATEST(NEW.earned_amount+NEW.adjustment_amount,0),2);
  INSERT INTO finance.partner_payroll_periods
    (environment,partner_unit_id,unit_id,competence_month,closed_at,closed_by)
  VALUES (NEW.environment,NEW.partner_unit_id,NEW.unit_id,NEW.competence_month,NEW.closed_at,NEW.closed_by)
  ON CONFLICT (environment,partner_unit_id,competence_month) DO NOTHING;
  SELECT id INTO v_payroll_period_id FROM finance.partner_payroll_periods
   WHERE environment=NEW.environment AND partner_unit_id=NEW.partner_unit_id
     AND competence_month=NEW.competence_month;
  INSERT INTO finance.partner_payroll_items
    (environment,payroll_period_id,commission_period_id,token_id,base_salary,
     benefits,commission_amount,total_due,payable_id,calculation)
  VALUES (NEW.environment,v_payroll_period_id,NEW.id,NEW.token_id,v_salary,v_benefits,
    v_commission,NEW.payable_amount,NEW.payable_id,
    jsonb_build_object('source','partner_staff_commission_periods','frequency','monthly',
      'salary_frequency',COALESCE(v_comp.salary_frequency,'monthly'),
      'configured_salary',COALESCE(v_comp.base_salary,0),'sales_count',NEW.sales_count,
      'gross_sales',NEW.gross_sales,'earned_amount',NEW.earned_amount,
      'adjustment_amount',NEW.adjustment_amount,'employment_type',v_comp.employment_type,
      'benefits',COALESCE(v_comp.benefits,'[]'::jsonb),'compensation_starts_on',v_comp.starts_on))
  ON CONFLICT (environment,commission_period_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION finance.run_partner_staff_payroll_seed(
  p_environment env_t,p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  v_current DATE:=date_trunc('month',p_now AT TIME ZONE 'America/Sao_Paulo')::date;
  v_row RECORD; v_created INTEGER:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('partner-staff-payroll:'||p_environment::text));
  FOR v_row IN
    WITH candidates AS (
      SELECT pat.id token_id,pat.partner_unit_id,pu.unit_id,month_start::date competence_month
        FROM network.partner_access_tokens pat
        JOIN network.partner_units pu ON pu.environment=pat.environment AND pu.id=pat.partner_unit_id
        CROSS JOIN LATERAL generate_series(
          date_trunc('month',(SELECT min(c.starts_on) FROM network.partner_collaborator_compensation c
            WHERE c.environment=pat.environment AND c.token_id=pat.id))::date,
          (v_current-interval '1 month')::date,interval '1 month') month_start
       WHERE pat.environment=p_environment AND pat.role='funcionario'
         AND pat.created_at<(month_start+interval '1 month')
         AND (pat.revoked_at IS NULL OR pat.revoked_at>=month_start)
    )
    SELECT c.* FROM candidates c
     JOIN LATERAL (
       SELECT cfg.base_salary,cfg.salary_frequency,cfg.benefits
         FROM network.partner_collaborator_compensation cfg
        WHERE cfg.environment=p_environment AND cfg.token_id=c.token_id
          AND cfg.starts_on<(c.competence_month+interval '1 month')::date
        ORDER BY cfg.starts_on DESC LIMIT 1
     ) cfg ON true
    WHERE ((cfg.salary_frequency='monthly' AND cfg.base_salary>0) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(cfg.benefits) item
       WHERE COALESCE((item->>'active')::boolean,true) AND (item->>'amount')::numeric>0))
      AND NOT EXISTS (SELECT 1 FROM finance.partner_staff_commission_periods period
        WHERE period.environment=p_environment AND period.token_id=c.token_id
          AND period.settlement_frequency='monthly' AND period.competence_month=c.competence_month)
    ORDER BY c.competence_month,c.token_id
  LOOP
    INSERT INTO finance.partner_staff_commission_periods
      (environment,partner_unit_id,unit_id,token_id,competence_month,
       settlement_frequency,period_start,period_end,sales_count,gross_sales,
       earned_amount,adjustment_amount,payable_amount,payable_id,closed_at)
    VALUES (p_environment,v_row.partner_unit_id,v_row.unit_id,v_row.token_id,
      v_row.competence_month,'monthly',v_row.competence_month,
      (v_row.competence_month+interval '1 month'-interval '1 day')::date,
      0,0,0,0,0,NULL,p_now)
    ON CONFLICT (environment,token_id,settlement_frequency,period_start) DO NOTHING;
    IF FOUND THEN v_created:=v_created+1; END IF;
  END LOOP;
  RETURN jsonb_build_object('environment',p_environment,'current_month',v_current,
    'periods_created',v_created);
END;
$function$;

CREATE OR REPLACE FUNCTION finance.guard_matriz_commission_expense()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM finance.matriz_commission_periods p
    WHERE p.environment=OLD.environment AND p.source_expense_id=OLD.id)
     AND NOT EXISTS (SELECT 1 FROM finance.matriz_salary_periods p
    WHERE p.environment=OLD.environment AND p.source_expense_id=OLD.id) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'weekly_commission_expense_locked'; END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR ROW(NEW.environment,NEW.category,NEW.amount,NEW.occurred_at,NEW.due_date,
            NEW.competence_month,NEW.document_date)
        IS DISTINCT FROM
        ROW(OLD.environment,OLD.category,OLD.amount,OLD.occurred_at,OLD.due_date,
            OLD.competence_month,OLD.document_date) THEN
    RAISE EXCEPTION 'weekly_commission_expense_locked';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION finance.sync_matriz_commission_expense_payment()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.payment_status='pending' AND NEW.payment_status='paid' THEN
    UPDATE finance.matriz_commission_periods SET payment_status='paid',paid_at=NEW.paid_at,
      paid_by=COALESCE(NULLIF(current_setting('app.actor_label',true),''),'financeiro:despesa')
     WHERE environment=NEW.environment AND source_expense_id=NEW.id AND payment_status='pending';
    UPDATE finance.matriz_salary_periods SET payment_status='paid',paid_at=NEW.paid_at,
      paid_by=COALESCE(NULLIF(current_setting('app.actor_label',true),''),'financeiro:despesa')
     WHERE environment=NEW.environment AND source_expense_id=NEW.id AND payment_status='pending';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON finance.partner_staff_salary_periods FROM PUBLIC;
REVOKE ALL ON finance.matriz_salary_periods FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_partner_staff_salary_period() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_matriz_salary_period() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.run_partner_staff_salary_rollover(env_t,timestamptz) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON finance.partner_staff_salary_periods FROM farejador_partner_app;
    REVOKE ALL ON finance.matriz_salary_periods FROM farejador_partner_app;
  END IF;
END;
$grants$;

DO $assertions$
BEGIN
  IF EXISTS (SELECT 1 FROM network.matriz_collaborator_compensation
    WHERE salary_frequency NOT IN ('weekly','monthly')) THEN RAISE EXCEPTION 'matriz_salary_frequency_invalid'; END IF;
  IF EXISTS (SELECT 1 FROM network.partner_collaborator_compensation
    WHERE salary_frequency NOT IN ('weekly','monthly')) THEN RAISE EXCEPTION 'partner_salary_frequency_invalid'; END IF;
END;
$assertions$;

COMMENT ON COLUMN network.matriz_collaborator_compensation.salary_frequency IS
  'weekly usa o valor exato por domingo-sabado; monthly usa o valor integral mensal.';
COMMENT ON COLUMN network.partner_collaborator_compensation.salary_frequency IS
  'weekly usa o valor exato por domingo-sabado; monthly usa o valor integral mensal.';
