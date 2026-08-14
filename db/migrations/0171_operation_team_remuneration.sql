-- 0171_operation_team_remuneration.sql
-- Remuneracao versionada na Operacao da Loja. A Matriz continua fechando pela
-- folha existente; no parceiro, salario, beneficios e comissao passam a formar
-- uma unica conta por colaborador/competencia, sem duplicar a saida financeira.

CREATE OR REPLACE FUNCTION network.valid_operation_benefits(p_value JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $function$
  SELECT jsonb_typeof(p_value)='array'
     AND jsonb_array_length(p_value)<=12
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_value) item
        WHERE jsonb_typeof(item)<>'object'
           OR jsonb_typeof(item->'name')<>'string'
           OR length(btrim(item->>'name')) NOT BETWEEN 2 AND 60
           OR jsonb_typeof(item->'amount')<>'number'
           OR (item->>'amount')::numeric<0
           OR (item ? 'active' AND jsonb_typeof(item->'active')<>'boolean')
     );
$function$;

ALTER TABLE network.matriz_collaborator_compensation
  ADD COLUMN IF NOT EXISTS benefits JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE network.matriz_collaborator_compensation
  DROP CONSTRAINT IF EXISTS matriz_collaborator_compensation_benefits_check;
ALTER TABLE network.matriz_collaborator_compensation
  ADD CONSTRAINT matriz_collaborator_compensation_benefits_check
  CHECK (network.valid_operation_benefits(benefits));

CREATE TABLE IF NOT EXISTS network.partner_collaborator_compensation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  partner_unit_id UUID NOT NULL,
  token_id UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  employment_type TEXT NOT NULL CHECK (employment_type IN ('clt','mei','autonomo','outro')),
  base_salary NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (base_salary>=0),
  payment_day SMALLINT NOT NULL DEFAULT 5 CHECK (payment_day BETWEEN 1 AND 28),
  payment_method TEXT NOT NULL DEFAULT 'pix'
    CHECK (payment_method IN ('pix','transferencia','dinheiro','outro')),
  starts_on DATE NOT NULL,
  benefits JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (network.valid_operation_benefits(benefits)),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_collaborator_compensation_version_uniq UNIQUE (token_id,starts_on),
  CONSTRAINT partner_collaborator_compensation_unit_fk
    FOREIGN KEY (environment,partner_unit_id)
    REFERENCES network.partner_units(environment,id)
);

CREATE INDEX IF NOT EXISTS partner_collaborator_compensation_effective_idx
  ON network.partner_collaborator_compensation(environment,token_id,starts_on DESC);

CREATE TABLE IF NOT EXISTS network.partner_token_commission_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  partner_unit_id UUID NOT NULL,
  token_id UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  kind TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
  value NUMERIC(12,2) NOT NULL CHECK (value>=0),
  active BOOLEAN NOT NULL DEFAULT true,
  starts_on DATE NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_token_commission_history_version_uniq UNIQUE (token_id,starts_on),
  CONSTRAINT partner_token_commission_history_unit_fk
    FOREIGN KEY (environment,partner_unit_id)
    REFERENCES network.partner_units(environment,id),
  CHECK (kind<>'percent' OR value<=100)
);

CREATE INDEX IF NOT EXISTS partner_token_commission_history_effective_idx
  ON network.partner_token_commission_history(environment,token_id,starts_on DESC);

INSERT INTO network.partner_token_commission_history
  (environment,partner_unit_id,token_id,kind,value,active,starts_on,updated_by,updated_at)
SELECT environment,partner_unit_id,token_id,kind,value,active,
       (updated_at AT TIME ZONE 'America/Sao_Paulo')::date,updated_by,updated_at
  FROM network.partner_token_commission
ON CONFLICT (token_id,starts_on) DO NOTHING;

DROP TRIGGER IF EXISTS env_match_partner_compensation_token
  ON network.partner_collaborator_compensation;
CREATE TRIGGER env_match_partner_compensation_token
  BEFORE INSERT OR UPDATE OF environment,token_id
  ON network.partner_collaborator_compensation FOR EACH ROW
  EXECUTE FUNCTION ops.validate_env_match('network','partner_access_tokens','token_id');

DROP TRIGGER IF EXISTS env_match_partner_commission_history_token
  ON network.partner_token_commission_history;
CREATE TRIGGER env_match_partner_commission_history_token
  BEFORE INSERT OR UPDATE OF environment,token_id
  ON network.partner_token_commission_history FOR EACH ROW
  EXECUTE FUNCTION ops.validate_env_match('network','partner_access_tokens','token_id');

-- Executa antes da imutabilidade do periodo existir. Assim a conta de comissao
-- criada pelo legado e ampliada para a folha completa uma unica vez.
CREATE OR REPLACE FUNCTION finance.prepare_partner_payroll_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  v_comp RECORD;
  v_benefits NUMERIC(14,2) := 0;
  v_commission NUMERIC(14,2) := 0;
  v_total NUMERIC(14,2) := 0;
  v_counterparty TEXT;
  v_due DATE;
BEGIN
  SELECT c.* INTO v_comp
    FROM network.partner_collaborator_compensation c
   WHERE c.environment=NEW.environment AND c.token_id=NEW.token_id
     AND c.starts_on<(NEW.competence_month+interval '1 month')::date
   ORDER BY c.starts_on DESC LIMIT 1;

  IF v_comp.id IS NOT NULL THEN
    SELECT COALESCE(sum((item->>'amount')::numeric)
      FILTER (WHERE COALESCE((item->>'active')::boolean,true)),0)::numeric(14,2)
      INTO v_benefits FROM jsonb_array_elements(v_comp.benefits) item;
  END IF;
  v_commission := round(GREATEST(NEW.earned_amount+NEW.adjustment_amount,0),2);
  v_total := round(COALESCE(v_comp.base_salary,0)+v_benefits+v_commission,2);
  v_due := (NEW.competence_month+interval '1 month'
    +(LEAST(COALESCE(v_comp.payment_day,5),28)-1)*interval '1 day')::date;

  SELECT COALESCE(NULLIF(btrim(pat.label),''),NULLIF(btrim(pat.login_username),''),'Funcionario')
    INTO v_counterparty FROM network.partner_access_tokens pat
   WHERE pat.environment=NEW.environment AND pat.id=NEW.token_id;

  IF v_total>0 AND NEW.payable_id IS NOT NULL THEN
    UPDATE finance.partner_payables SET amount=v_total,
           description='Folha da equipe - '||to_char(NEW.competence_month,'MM/YYYY'),
           due_date=v_due,notes='Salario, beneficios e comissao em um unico fechamento.'
     WHERE environment=NEW.environment AND id=NEW.payable_id;
  ELSIF v_total>0 THEN
    INSERT INTO finance.partner_payables
      (environment,unit_id,counterparty_name,description,category,amount,due_date,
       status,notes,idempotency_key,created_by,competence_month)
    VALUES
      (NEW.environment,NEW.unit_id,v_counterparty,
       'Folha da equipe - '||to_char(NEW.competence_month,'MM/YYYY'),'employee',
       v_total,v_due,'open','Salario, beneficios e comissao em um unico fechamento.',
       'staff-payroll:'||NEW.token_id::text||':'||to_char(NEW.competence_month,'YYYY-MM'),
       'system:monthly-rollover',NEW.competence_month)
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
    DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
    RETURNING id INTO NEW.payable_id;
  ELSE
    NEW.payable_id := NULL;
  END IF;
  NEW.payable_amount := v_total;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_payroll_prepare
  ON finance.partner_staff_commission_periods;
CREATE TRIGGER partner_payroll_prepare
BEFORE INSERT ON finance.partner_staff_commission_periods
FOR EACH ROW EXECUTE FUNCTION finance.prepare_partner_payroll_period();

CREATE OR REPLACE FUNCTION finance.sync_partner_commission_to_payroll()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  v_payroll_period_id UUID;
  v_comp RECORD;
  v_benefits NUMERIC(14,2) := 0;
  v_commission NUMERIC(14,2) := 0;
BEGIN
  SELECT c.* INTO v_comp FROM network.partner_collaborator_compensation c
   WHERE c.environment=NEW.environment AND c.token_id=NEW.token_id
     AND c.starts_on<(NEW.competence_month+interval '1 month')::date
   ORDER BY c.starts_on DESC LIMIT 1;
  IF v_comp.id IS NOT NULL THEN
    SELECT COALESCE(sum((item->>'amount')::numeric)
      FILTER (WHERE COALESCE((item->>'active')::boolean,true)),0)::numeric(14,2)
      INTO v_benefits FROM jsonb_array_elements(v_comp.benefits) item;
  END IF;
  v_commission := round(GREATEST(NEW.earned_amount+NEW.adjustment_amount,0),2);

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
  VALUES
    (NEW.environment,v_payroll_period_id,NEW.id,NEW.token_id,
     COALESCE(v_comp.base_salary,0),v_benefits,v_commission,NEW.payable_amount,NEW.payable_id,
     jsonb_build_object('source','partner_staff_commission_periods',
       'sales_count',NEW.sales_count,'gross_sales',NEW.gross_sales,
       'earned_amount',NEW.earned_amount,'adjustment_amount',NEW.adjustment_amount,
       'employment_type',v_comp.employment_type,'benefits',COALESCE(v_comp.benefits,'[]'::jsonb),
       'compensation_starts_on',v_comp.starts_on))
  ON CONFLICT (environment,commission_period_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

-- Depois do rollover de comissoes, cria folha tambem para quem possui salario
-- mas nao vendeu no mes. Periodos existentes sao ignorados pela chave canonica.
CREATE OR REPLACE FUNCTION finance.run_partner_staff_payroll_seed(
  p_environment env_t,p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  v_current DATE := date_trunc('month',p_now AT TIME ZONE 'America/Sao_Paulo')::date;
  v_row RECORD;
  v_created INTEGER := 0;
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
       SELECT cfg.base_salary,cfg.benefits
         FROM network.partner_collaborator_compensation cfg
        WHERE cfg.environment=p_environment AND cfg.token_id=c.token_id
          AND cfg.starts_on<(c.competence_month+interval '1 month')::date
        ORDER BY cfg.starts_on DESC LIMIT 1
     ) cfg ON true
    WHERE (cfg.base_salary>0 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(cfg.benefits) item
       WHERE COALESCE((item->>'active')::boolean,true) AND (item->>'amount')::numeric>0))
      AND NOT EXISTS (SELECT 1 FROM finance.partner_staff_commission_periods period
        WHERE period.environment=p_environment AND period.token_id=c.token_id
          AND period.competence_month=c.competence_month)
    ORDER BY c.competence_month,c.token_id
  LOOP
    INSERT INTO finance.partner_staff_commission_periods
      (environment,partner_unit_id,unit_id,token_id,competence_month,
       sales_count,gross_sales,earned_amount,adjustment_amount,payable_amount,payable_id,closed_at)
    VALUES (p_environment,v_row.partner_unit_id,v_row.unit_id,v_row.token_id,v_row.competence_month,
      0,0,0,0,0,NULL,p_now)
    ON CONFLICT (environment,token_id,competence_month) DO NOTHING;
    IF FOUND THEN v_created:=v_created+1; END IF;
  END LOOP;
  RETURN jsonb_build_object('environment',p_environment,'current_month',v_current,'periods_created',v_created);
END;
$function$;

REVOKE ALL ON network.partner_collaborator_compensation FROM PUBLIC;
REVOKE ALL ON network.partner_token_commission_history FROM PUBLIC;
REVOKE ALL ON FUNCTION network.valid_operation_benefits(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.prepare_partner_payroll_period() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.run_partner_staff_payroll_seed(env_t,timestamptz) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON network.matriz_collaborator_compensation FROM farejador_partner_app;
    REVOKE ALL ON network.partner_collaborator_compensation FROM farejador_partner_app;
    REVOKE ALL ON network.partner_token_commission_history FROM farejador_partner_app;
  END IF;
END;
$grants$;

DO $assertions$
BEGIN
  IF EXISTS (SELECT 1 FROM network.matriz_collaborator_compensation
    WHERE NOT network.valid_operation_benefits(benefits)) THEN
    RAISE EXCEPTION 'matriz_benefits_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM network.partner_collaborator_compensation c
    LEFT JOIN network.partner_access_tokens pat
      ON pat.environment=c.environment AND pat.id=c.token_id AND pat.partner_unit_id=c.partner_unit_id
    WHERE pat.id IS NULL) THEN RAISE EXCEPTION 'partner_compensation_scope_invalid'; END IF;
END;
$assertions$;

COMMENT ON TABLE network.partner_collaborator_compensation IS
  'Remuneracao versionada do colaborador parceiro; periodos fechados guardam snapshot imutavel.';
COMMENT ON TABLE network.partner_token_commission_history IS
  'Historico de regras de comissao do parceiro; vendas realizadas continuam congeladas no livro financeiro.';
