-- 0193 - Rollovers da equipe parceira respeitam os periodos preservados pela 0192.

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
       AND finance.partner_collaborator_employed_in_period(
         p_environment,pat.id,week_start::date,(week_start::date+6)::date)
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

CREATE OR REPLACE FUNCTION finance.prepare_partner_payroll_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  v_comp RECORD; v_salary NUMERIC(14,2):=0; v_benefits NUMERIC(14,2):=0;
  v_commission NUMERIC(14,2):=0; v_total NUMERIC(14,2):=0; v_counterparty TEXT; v_due DATE;
  v_employed BOOLEAN:=false;
BEGIN
  IF NEW.settlement_frequency='weekly' THEN RETURN NEW; END IF;
  v_employed:=finance.partner_collaborator_employed_in_period(
    NEW.environment,NEW.token_id,NEW.competence_month,
    (NEW.competence_month+interval '1 month'-interval '1 day')::date);
  SELECT c.* INTO v_comp FROM network.partner_collaborator_compensation c
   WHERE c.environment=NEW.environment AND c.token_id=NEW.token_id
     AND c.starts_on<(NEW.competence_month+interval '1 month')::date
   ORDER BY c.starts_on DESC LIMIT 1;
  IF v_employed AND v_comp.id IS NOT NULL THEN
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
  v_benefits NUMERIC(14,2):=0; v_commission NUMERIC(14,2):=0; v_employed BOOLEAN:=false;
BEGIN
  IF NEW.settlement_frequency='weekly' THEN RETURN NEW; END IF;
  v_employed:=finance.partner_collaborator_employed_in_period(
    NEW.environment,NEW.token_id,NEW.competence_month,
    (NEW.competence_month+interval '1 month'-interval '1 day')::date);
  SELECT c.* INTO v_comp FROM network.partner_collaborator_compensation c
   WHERE c.environment=NEW.environment AND c.token_id=NEW.token_id
     AND c.starts_on<(NEW.competence_month+interval '1 month')::date
   ORDER BY c.starts_on DESC LIMIT 1;
  IF v_employed AND v_comp.id IS NOT NULL THEN
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
      'benefits',COALESCE(v_comp.benefits,'[]'::jsonb),'compensation_starts_on',v_comp.starts_on,
      'employed_in_competence',v_employed))
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
         AND finance.partner_collaborator_employed_in_period(
           p_environment,pat.id,month_start::date,
           (month_start+interval '1 month'-interval '1 day')::date)
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

REVOKE ALL ON FUNCTION finance.run_partner_staff_salary_rollover(env_t,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.run_partner_staff_payroll_seed(env_t,timestamptz) FROM PUBLIC;
