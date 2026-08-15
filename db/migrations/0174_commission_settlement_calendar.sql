-- 0174 - Calendario de fechamento das comissoes da Operacao da Loja.
--
-- A regra pode fechar semanalmente (domingo a sabado) ou mensalmente. Salario
-- e beneficios continuam mensais. O periodo fica congelado e a chave natural
-- por colaborador/data impede que uma comissao seja fechada ou paga duas vezes.

ALTER TABLE network.matriz_collaborator_commission_rules
  ADD COLUMN IF NOT EXISTS settlement_frequency TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE network.matriz_collaborator_commission_rules
  DROP CONSTRAINT IF EXISTS matriz_commission_settlement_frequency_check;
ALTER TABLE network.matriz_collaborator_commission_rules
  ADD CONSTRAINT matriz_commission_settlement_frequency_check
  CHECK (settlement_frequency IN ('weekly','monthly'));

ALTER TABLE network.partner_token_commission
  ADD COLUMN IF NOT EXISTS settlement_frequency TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE network.partner_token_commission
  DROP CONSTRAINT IF EXISTS partner_commission_settlement_frequency_check;
ALTER TABLE network.partner_token_commission
  ADD CONSTRAINT partner_commission_settlement_frequency_check
  CHECK (settlement_frequency IN ('weekly','monthly'));

ALTER TABLE network.partner_token_commission_history
  ADD COLUMN IF NOT EXISTS settlement_frequency TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE network.partner_token_commission_history
  DROP CONSTRAINT IF EXISTS partner_commission_history_settlement_frequency_check;
ALTER TABLE network.partner_token_commission_history
  ADD CONSTRAINT partner_commission_history_settlement_frequency_check
  CHECK (settlement_frequency IN ('weekly','monthly'));

ALTER TABLE finance.partner_staff_commission_entries
  ADD COLUMN IF NOT EXISTS settlement_frequency TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE finance.partner_staff_commission_entries
  DROP CONSTRAINT IF EXISTS partner_staff_entry_settlement_frequency_check;
ALTER TABLE finance.partner_staff_commission_entries
  ADD CONSTRAINT partner_staff_entry_settlement_frequency_check
  CHECK (settlement_frequency IN ('weekly','monthly'));

ALTER TABLE finance.partner_staff_commission_adjustments
  ADD COLUMN IF NOT EXISTS settlement_frequency TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE finance.partner_staff_commission_adjustments
  DROP CONSTRAINT IF EXISTS partner_staff_adjustment_settlement_frequency_check;
ALTER TABLE finance.partner_staff_commission_adjustments
  ADD CONSTRAINT partner_staff_adjustment_settlement_frequency_check
  CHECK (settlement_frequency IN ('weekly','monthly'));

ALTER TABLE finance.partner_staff_commission_periods
  ADD COLUMN IF NOT EXISTS settlement_frequency TEXT NOT NULL DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS period_start DATE,
  ADD COLUMN IF NOT EXISTS period_end DATE;

UPDATE finance.partner_staff_commission_periods
   SET period_start=competence_month,
       period_end=(competence_month+interval '1 month'-interval '1 day')::date,
       settlement_frequency='monthly'
 WHERE period_start IS NULL OR period_end IS NULL;

ALTER TABLE finance.partner_staff_commission_periods
  ALTER COLUMN period_start SET NOT NULL,
  ALTER COLUMN period_end SET NOT NULL;
ALTER TABLE finance.partner_staff_commission_periods
  DROP CONSTRAINT IF EXISTS partner_staff_commission_periods_uniq;
ALTER TABLE finance.partner_staff_commission_periods
  DROP CONSTRAINT IF EXISTS partner_staff_period_calendar_check;
ALTER TABLE finance.partner_staff_commission_periods
  ADD CONSTRAINT partner_staff_period_calendar_check CHECK (
    period_end>=period_start
    AND settlement_frequency IN ('weekly','monthly')
    AND ((settlement_frequency='weekly'
          AND extract(dow FROM period_start)=0 AND period_end=period_start+6)
      OR (settlement_frequency='monthly'
          AND period_start=date_trunc('month',period_start)::date
          AND period_end=(period_start+interval '1 month'-interval '1 day')::date))
  );
ALTER TABLE finance.partner_staff_commission_periods
  ADD CONSTRAINT partner_staff_commission_periods_uniq
  UNIQUE (environment,token_id,settlement_frequency,period_start);

CREATE INDEX IF NOT EXISTS partner_staff_commission_period_calendar_idx
  ON finance.partner_staff_commission_periods
  (environment,unit_id,settlement_frequency,period_start DESC);

CREATE OR REPLACE FUNCTION finance.normalize_partner_commission_period_calendar()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  NEW.settlement_frequency:=COALESCE(NEW.settlement_frequency,'monthly');
  IF NEW.settlement_frequency='weekly' THEN
    IF NEW.period_start IS NULL THEN RAISE EXCEPTION 'weekly_period_start_required'; END IF;
    NEW.period_end:=COALESCE(NEW.period_end,NEW.period_start+6);
  ELSE
    NEW.period_start:=COALESCE(NEW.period_start,NEW.competence_month);
    NEW.period_end:=COALESCE(NEW.period_end,(NEW.period_start+interval '1 month'-interval '1 day')::date);
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS a_partner_commission_period_calendar
  ON finance.partner_staff_commission_periods;
CREATE TRIGGER a_partner_commission_period_calendar
BEFORE INSERT ON finance.partner_staff_commission_periods
FOR EACH ROW EXECUTE FUNCTION finance.normalize_partner_commission_period_calendar();

-- Frequencia e regra usada sao fatos congelados junto da venda.
CREATE OR REPLACE FUNCTION finance.snapshot_partner_itemized_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE
  v_rule RECORD;
BEGIN
  SELECT kind,value,active,itemized,item_rules,settlement_frequency INTO v_rule
    FROM network.partner_token_commission_history
   WHERE environment=NEW.environment AND token_id=NEW.token_id
     AND starts_on<=(NEW.realized_at AT TIME ZONE 'America/Sao_Paulo')::date
     AND updated_at<=NEW.realized_at
   ORDER BY starts_on DESC LIMIT 1;
  IF v_rule.kind IS NULL THEN
    SELECT kind,value,active,itemized,item_rules,settlement_frequency INTO v_rule
      FROM network.partner_token_commission
     WHERE environment=NEW.environment AND token_id=NEW.token_id
       AND updated_at<=NEW.realized_at LIMIT 1;
  END IF;
  IF v_rule.kind IS NULL OR NOT COALESCE(v_rule.active,false) THEN RETURN NEW; END IF;
  NEW.settlement_frequency := COALESCE(v_rule.settlement_frequency,'monthly');
  IF COALESCE(v_rule.itemized,false) THEN
    NEW.commission_itemized := true;
    NEW.commission_rules := v_rule.item_rules;
    NEW.commission_amount := finance.partner_itemized_commission(
      NEW.environment,NEW.partner_order_id,v_rule.item_rules);
  ELSE
    NEW.commission_itemized := false;
    NEW.commission_rules := '{}'::jsonb;
    NEW.commission_kind := v_rule.kind;
    NEW.commission_value := v_rule.value;
    NEW.commission_amount := CASE WHEN v_rule.kind='percent'
      THEN round(NEW.gross_amount*v_rule.value/100.0,2) ELSE v_rule.value END;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION finance.guard_partner_staff_commission_fact()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'partner_staff_commission_fact_immutable'; END IF;
  IF ROW(NEW.environment,NEW.partner_unit_id,NEW.unit_id,NEW.token_id,
         NEW.partner_order_id,NEW.competence_month,NEW.gross_amount,
         NEW.commission_kind,NEW.commission_value,NEW.commission_amount,
         NEW.commission_itemized,NEW.commission_rules,NEW.settlement_frequency,
         NEW.realized_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.environment,OLD.partner_unit_id,OLD.unit_id,OLD.token_id,
         OLD.partner_order_id,OLD.competence_month,OLD.gross_amount,
         OLD.commission_kind,OLD.commission_value,OLD.commission_amount,
         OLD.commission_itemized,OLD.commission_rules,OLD.settlement_frequency,
         OLD.realized_at,OLD.created_at) THEN
    RAISE EXCEPTION 'partner_staff_commission_fact_immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION finance.snapshot_partner_staff_adjustment_frequency()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
  SELECT settlement_frequency INTO NEW.settlement_frequency
    FROM finance.partner_staff_commission_entries
   WHERE environment=NEW.environment AND id=NEW.commission_entry_id;
  NEW.settlement_frequency := COALESCE(NEW.settlement_frequency,'monthly');
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS partner_staff_adjustment_frequency_snapshot
  ON finance.partner_staff_commission_adjustments;
CREATE TRIGGER partner_staff_adjustment_frequency_snapshot
BEFORE INSERT ON finance.partner_staff_commission_adjustments
FOR EACH ROW EXECUTE FUNCTION finance.snapshot_partner_staff_adjustment_frequency();

CREATE OR REPLACE FUNCTION finance.guard_partner_staff_adjustment_fact()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='DELETE' OR
     ROW(NEW.environment,NEW.partner_unit_id,NEW.unit_id,NEW.token_id,
         NEW.commission_entry_id,NEW.competence_month,NEW.amount,
         NEW.reason,NEW.occurred_at,NEW.settlement_frequency,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.environment,OLD.partner_unit_id,OLD.unit_id,OLD.token_id,
         OLD.commission_entry_id,OLD.competence_month,OLD.amount,
         OLD.reason,OLD.occurred_at,OLD.settlement_frequency,OLD.created_at) THEN
    RAISE EXCEPTION 'partner_staff_commission_adjustment_immutable';
  END IF;
  RETURN NEW;
END;
$function$;

-- Semanal e comissao pura. Mensal continua convergindo salario, beneficios e
-- comissao na folha ja existente.
CREATE OR REPLACE FUNCTION finance.prepare_partner_payroll_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  v_comp RECORD; v_benefits NUMERIC(14,2):=0; v_commission NUMERIC(14,2):=0;
  v_total NUMERIC(14,2):=0; v_counterparty TEXT; v_due DATE;
BEGIN
  IF NEW.settlement_frequency='weekly' THEN RETURN NEW; END IF;
  SELECT c.* INTO v_comp FROM network.partner_collaborator_compensation c
   WHERE c.environment=NEW.environment AND c.token_id=NEW.token_id
     AND c.starts_on<(NEW.competence_month+interval '1 month')::date
   ORDER BY c.starts_on DESC LIMIT 1;
  IF v_comp.id IS NOT NULL THEN
    SELECT COALESCE(sum((item->>'amount')::numeric)
      FILTER (WHERE COALESCE((item->>'active')::boolean,true)),0)::numeric(14,2)
      INTO v_benefits FROM jsonb_array_elements(v_comp.benefits) item;
  END IF;
  v_commission:=round(GREATEST(NEW.earned_amount+NEW.adjustment_amount,0),2);
  v_total:=round(COALESCE(v_comp.base_salary,0)+v_benefits+v_commission,2);
  v_due:=(NEW.competence_month+interval '1 month'
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
    VALUES (NEW.environment,NEW.unit_id,v_counterparty,
      'Folha da equipe - '||to_char(NEW.competence_month,'MM/YYYY'),'employee',
      v_total,v_due,'open','Salario, beneficios e comissao em um unico fechamento.',
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
  v_payroll_period_id UUID; v_comp RECORD; v_benefits NUMERIC(14,2):=0;
  v_commission NUMERIC(14,2):=0;
BEGIN
  IF NEW.settlement_frequency='weekly' THEN RETURN NEW; END IF;
  SELECT c.* INTO v_comp FROM network.partner_collaborator_compensation c
   WHERE c.environment=NEW.environment AND c.token_id=NEW.token_id
     AND c.starts_on<(NEW.competence_month+interval '1 month')::date
   ORDER BY c.starts_on DESC LIMIT 1;
  IF v_comp.id IS NOT NULL THEN
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
  VALUES (NEW.environment,v_payroll_period_id,NEW.id,NEW.token_id,
    COALESCE(v_comp.base_salary,0),v_benefits,v_commission,NEW.payable_amount,NEW.payable_id,
    jsonb_build_object('source','partner_staff_commission_periods','frequency','monthly',
      'sales_count',NEW.sales_count,'gross_sales',NEW.gross_sales,
      'earned_amount',NEW.earned_amount,'adjustment_amount',NEW.adjustment_amount,
      'employment_type',v_comp.employment_type,'benefits',COALESCE(v_comp.benefits,'[]'::jsonb),
      'compensation_starts_on',v_comp.starts_on))
  ON CONFLICT (environment,commission_period_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION finance.run_partner_staff_commission_rollover(
  p_environment env_t,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE
  v_today DATE:=(p_now AT TIME ZONE 'America/Sao_Paulo')::date;
  v_current_month DATE:=date_trunc('month',v_today)::date;
  v_bucket RECORD; v_totals RECORD; v_counterparty TEXT;
  v_payable_id UUID; v_period_id UUID; v_closed INTEGER:=0;
  v_weekly_closed INTEGER:=0; v_payables INTEGER:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('partner-staff-commission:'||p_environment::text));

  WITH realized AS (
    SELECT po.*,CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
      ELSE COALESCE(po.retrieved_at,po.created_at) END realized_at
      FROM commerce.partner_orders po
     WHERE po.environment=p_environment AND po.operator_token_id IS NOT NULL
       AND po.status<>'cancelled' AND po.deleted_at IS NULL
       AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
       AND NOT po.awaiting_pickup
  )
  INSERT INTO finance.partner_staff_commission_entries
    (environment,partner_unit_id,unit_id,token_id,partner_order_id,
     competence_month,gross_amount,commission_kind,commission_value,
     commission_amount,realized_at)
  SELECT r.environment,pat.partner_unit_id,r.unit_id,r.operator_token_id,r.id,
    date_trunc('month',r.realized_at AT TIME ZONE 'America/Sao_Paulo')::date,
    COALESCE(r.total_amount,0),cc.kind,cc.value,
    CASE WHEN cc.kind='percent' THEN round(COALESCE(r.total_amount,0)*cc.value/100.0,2)
      ELSE cc.value END,r.realized_at
  FROM realized r
  JOIN network.partner_access_tokens pat ON pat.id=r.operator_token_id
    AND pat.environment=r.environment AND pat.role='funcionario'
  JOIN network.partner_token_commission cc ON cc.token_id=pat.id
    AND cc.environment=pat.environment AND cc.active AND cc.value>0
    AND cc.updated_at<=r.realized_at
  ON CONFLICT (environment,partner_order_id) DO NOTHING;

  INSERT INTO finance.partner_staff_commission_adjustments
    (environment,partner_unit_id,unit_id,token_id,commission_entry_id,
     competence_month,amount,reason,occurred_at)
  SELECT ce.environment,ce.partner_unit_id,ce.unit_id,ce.token_id,ce.id,
    date_trunc('month',v_today)::date,-ce.commission_amount,
    'venda cancelada apos fechamento',p_now
  FROM finance.partner_staff_commission_entries ce
  JOIN commerce.partner_orders po ON po.environment=ce.environment
    AND po.id=ce.partner_order_id
  WHERE ce.environment=p_environment AND ce.status='earned'
    AND ce.settlement_period_id IS NOT NULL
    AND (po.status='cancelled' OR po.deleted_at IS NOT NULL
      OR (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
      OR po.awaiting_pickup)
  ON CONFLICT (environment,commission_entry_id) DO NOTHING;

  UPDATE finance.partner_staff_commission_entries ce
     SET status='reversed',reversed_at=p_now,reversal_reason='venda cancelada/desfeita'
    FROM commerce.partner_orders po
   WHERE ce.environment=p_environment AND po.environment=ce.environment
     AND po.id=ce.partner_order_id AND ce.status='earned'
     AND (po.status='cancelled' OR po.deleted_at IS NOT NULL
       OR (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
       OR po.awaiting_pickup);

  -- Fechamento mensal: somente fatos cuja regra congelada e mensal.
  FOR v_bucket IN
    SELECT DISTINCT token_id,partner_unit_id,unit_id,competence_month FROM (
      SELECT token_id,partner_unit_id,unit_id,competence_month
        FROM finance.partner_staff_commission_entries
       WHERE environment=p_environment AND status='earned'
         AND settlement_frequency='monthly' AND settlement_period_id IS NULL
         AND competence_month<v_current_month
      UNION ALL
      SELECT token_id,partner_unit_id,unit_id,competence_month
        FROM finance.partner_staff_commission_adjustments
       WHERE environment=p_environment AND settlement_frequency='monthly'
         AND settlement_period_id IS NULL AND competence_month<v_current_month
    ) monthly_buckets ORDER BY competence_month,token_id
  LOOP
    SELECT count(*)::int sales_count,COALESCE(sum(gross_amount),0)::numeric(14,2) gross_sales,
      COALESCE(sum(commission_amount),0)::numeric(14,2) earned_amount,
      COALESCE((SELECT sum(a.amount) FROM finance.partner_staff_commission_adjustments a
        WHERE a.environment=p_environment AND a.token_id=v_bucket.token_id
          AND a.settlement_frequency='monthly' AND a.settlement_period_id IS NULL
          AND a.competence_month<=v_bucket.competence_month),0)::numeric(14,2) adjustment_amount
      INTO v_totals
    FROM finance.partner_staff_commission_entries e
    WHERE e.environment=p_environment AND e.token_id=v_bucket.token_id
      AND e.status='earned' AND e.settlement_frequency='monthly'
      AND e.settlement_period_id IS NULL AND e.competence_month<=v_bucket.competence_month;
    IF round(v_totals.earned_amount+v_totals.adjustment_amount,2)<0 THEN CONTINUE; END IF;
    SELECT COALESCE(NULLIF(btrim(label),''),NULLIF(btrim(login_username),''),'Funcionario')
      INTO v_counterparty FROM network.partner_access_tokens
     WHERE id=v_bucket.token_id AND environment=p_environment;
    v_payable_id:=NULL;
    IF round(v_totals.earned_amount+v_totals.adjustment_amount,2)>0 THEN
      INSERT INTO finance.partner_payables
        (environment,unit_id,counterparty_name,description,category,amount,due_date,
         status,notes,idempotency_key,created_by,competence_month)
      VALUES (p_environment,v_bucket.unit_id,v_counterparty,
        'Comissao da equipe - '||to_char(v_bucket.competence_month,'MM/YYYY'),'employee',
        round(v_totals.earned_amount+v_totals.adjustment_amount,2),
        (v_bucket.competence_month+interval '1 month 4 days')::date,'open',
        'Fechamento automatico e imutavel por competencia.',
        'staff-commission:'||v_bucket.token_id::text||':'||to_char(v_bucket.competence_month,'YYYY-MM'),
        'system:monthly-rollover',v_bucket.competence_month)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
      DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id INTO v_payable_id;
      v_payables:=v_payables+1;
    END IF;
    INSERT INTO finance.partner_staff_commission_periods
      (environment,partner_unit_id,unit_id,token_id,competence_month,
       settlement_frequency,period_start,period_end,sales_count,gross_sales,
       earned_amount,adjustment_amount,payable_amount,payable_id,closed_at)
    VALUES (p_environment,v_bucket.partner_unit_id,v_bucket.unit_id,v_bucket.token_id,
      v_bucket.competence_month,'monthly',v_bucket.competence_month,
      (v_bucket.competence_month+interval '1 month'-interval '1 day')::date,
      v_totals.sales_count,v_totals.gross_sales,v_totals.earned_amount,
      v_totals.adjustment_amount,round(v_totals.earned_amount+v_totals.adjustment_amount,2),
      v_payable_id,p_now)
    ON CONFLICT (environment,token_id,settlement_frequency,period_start) DO NOTHING
    RETURNING id INTO v_period_id;
    IF v_period_id IS NULL THEN RAISE EXCEPTION 'partner_staff_commission_period_conflict'; END IF;
    UPDATE finance.partner_staff_commission_entries SET settlement_period_id=v_period_id
     WHERE environment=p_environment AND token_id=v_bucket.token_id AND status='earned'
       AND settlement_frequency='monthly' AND settlement_period_id IS NULL
       AND competence_month<=v_bucket.competence_month;
    UPDATE finance.partner_staff_commission_adjustments SET settlement_period_id=v_period_id
     WHERE environment=p_environment AND token_id=v_bucket.token_id
       AND settlement_frequency='monthly' AND settlement_period_id IS NULL
       AND competence_month<=v_bucket.competence_month;
    v_closed:=v_closed+1; v_period_id:=NULL;
  END LOOP;

  -- Fechamento semanal: cada domingo-sabado vira uma conta de comissao pura.
  FOR v_bucket IN
    SELECT DISTINCT token_id,partner_unit_id,unit_id,period_start FROM (
      SELECT token_id,partner_unit_id,unit_id,
        ((realized_at AT TIME ZONE 'America/Sao_Paulo')::date
          - extract(dow FROM realized_at AT TIME ZONE 'America/Sao_Paulo')::int)::date period_start
      FROM finance.partner_staff_commission_entries
      WHERE environment=p_environment AND status='earned'
        AND settlement_frequency='weekly' AND settlement_period_id IS NULL
      UNION
      SELECT token_id,partner_unit_id,unit_id,
        ((occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
          - extract(dow FROM occurred_at AT TIME ZONE 'America/Sao_Paulo')::int)::date
      FROM finance.partner_staff_commission_adjustments
      WHERE environment=p_environment AND settlement_frequency='weekly'
        AND settlement_period_id IS NULL
    ) weeks WHERE period_start+6<v_today ORDER BY period_start,token_id
  LOOP
    SELECT count(*)::int sales_count,COALESCE(sum(gross_amount),0)::numeric(14,2) gross_sales,
      COALESCE(sum(commission_amount),0)::numeric(14,2) earned_amount,
      COALESCE((SELECT sum(a.amount) FROM finance.partner_staff_commission_adjustments a
        WHERE a.environment=p_environment AND a.token_id=v_bucket.token_id
          AND a.settlement_frequency='weekly' AND a.settlement_period_id IS NULL
          AND (a.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date>=v_bucket.period_start
          AND (a.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date<v_bucket.period_start+7),0)::numeric(14,2) adjustment_amount
      INTO v_totals
    FROM finance.partner_staff_commission_entries e
    WHERE e.environment=p_environment AND e.token_id=v_bucket.token_id
      AND e.status='earned' AND e.settlement_frequency='weekly'
      AND e.settlement_period_id IS NULL
      AND (e.realized_at AT TIME ZONE 'America/Sao_Paulo')::date>=v_bucket.period_start
      AND (e.realized_at AT TIME ZONE 'America/Sao_Paulo')::date<v_bucket.period_start+7;
    IF round(v_totals.earned_amount+v_totals.adjustment_amount,2)<0 THEN CONTINUE; END IF;
    SELECT COALESCE(NULLIF(btrim(label),''),NULLIF(btrim(login_username),''),'Funcionario')
      INTO v_counterparty FROM network.partner_access_tokens
     WHERE id=v_bucket.token_id AND environment=p_environment;
    v_payable_id:=NULL;
    IF round(v_totals.earned_amount+v_totals.adjustment_amount,2)>0 THEN
      INSERT INTO finance.partner_payables
        (environment,unit_id,counterparty_name,description,category,amount,due_date,
         status,notes,idempotency_key,created_by,competence_month)
      VALUES (p_environment,v_bucket.unit_id,v_counterparty,
        'Comissao semanal - '||to_char(v_bucket.period_start,'DD/MM')||' a '||
          to_char(v_bucket.period_start+6,'DD/MM/YYYY'),'employee',
        round(v_totals.earned_amount+v_totals.adjustment_amount,2),v_bucket.period_start+7,
        'open','Comissao fechada de domingo a sabado.',
        'staff-commission-week:'||v_bucket.token_id::text||':'||v_bucket.period_start::text,
        'system:weekly-rollover',date_trunc('month',v_bucket.period_start)::date)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
      DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id INTO v_payable_id;
      v_payables:=v_payables+1;
    END IF;
    INSERT INTO finance.partner_staff_commission_periods
      (environment,partner_unit_id,unit_id,token_id,competence_month,
       settlement_frequency,period_start,period_end,sales_count,gross_sales,
       earned_amount,adjustment_amount,payable_amount,payable_id,closed_at,closed_by)
    VALUES (p_environment,v_bucket.partner_unit_id,v_bucket.unit_id,v_bucket.token_id,
      date_trunc('month',v_bucket.period_start)::date,'weekly',v_bucket.period_start,
      v_bucket.period_start+6,v_totals.sales_count,v_totals.gross_sales,
      v_totals.earned_amount,v_totals.adjustment_amount,
      round(v_totals.earned_amount+v_totals.adjustment_amount,2),v_payable_id,p_now,
      'system:weekly-rollover')
    ON CONFLICT (environment,token_id,settlement_frequency,period_start) DO NOTHING
    RETURNING id INTO v_period_id;
    IF v_period_id IS NULL THEN RAISE EXCEPTION 'partner_staff_weekly_period_conflict'; END IF;
    UPDATE finance.partner_staff_commission_entries SET settlement_period_id=v_period_id
     WHERE environment=p_environment AND token_id=v_bucket.token_id AND status='earned'
       AND settlement_frequency='weekly' AND settlement_period_id IS NULL
       AND (realized_at AT TIME ZONE 'America/Sao_Paulo')::date>=v_bucket.period_start
       AND (realized_at AT TIME ZONE 'America/Sao_Paulo')::date<v_bucket.period_start+7;
    UPDATE finance.partner_staff_commission_adjustments SET settlement_period_id=v_period_id
     WHERE environment=p_environment AND token_id=v_bucket.token_id
       AND settlement_frequency='weekly' AND settlement_period_id IS NULL
       AND (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date>=v_bucket.period_start
       AND (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date<v_bucket.period_start+7;
    v_closed:=v_closed+1; v_weekly_closed:=v_weekly_closed+1; v_period_id:=NULL;
  END LOOP;
  RETURN jsonb_build_object('environment',p_environment,'current_month',v_current_month,
    'periods_closed',v_closed,'weekly_periods_closed',v_weekly_closed,
    'payables_created',v_payables);
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
          AND period.settlement_frequency='monthly'
          AND period.competence_month=c.competence_month)
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

CREATE TABLE IF NOT EXISTS finance.matriz_commission_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  collaborator_id UUID NOT NULL REFERENCES network.matriz_collaborators(id),
  settlement_frequency TEXT NOT NULL CHECK (settlement_frequency='weekly'),
  period_start DATE NOT NULL CHECK (extract(dow FROM period_start)=0),
  period_end DATE NOT NULL CHECK (period_end=period_start+6),
  sales_count INTEGER NOT NULL CHECK (sales_count>=0),
  gross_sales NUMERIC(14,2) NOT NULL CHECK (gross_sales>=0),
  commission_amount NUMERIC(14,2) NOT NULL CHECK (commission_amount>0),
  source_expense_id UUID NOT NULL UNIQUE REFERENCES commerce.matriz_expenses(id),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid')),
  paid_at TIMESTAMPTZ,
  paid_by TEXT,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by TEXT NOT NULL DEFAULT 'system:commission-rollover',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment,collaborator_id,settlement_frequency,period_start),
  CHECK ((payment_status='pending' AND paid_at IS NULL) OR
         (payment_status='paid' AND paid_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS matriz_commission_period_status_idx
  ON finance.matriz_commission_periods(environment,payment_status,period_start DESC);

CREATE OR REPLACE FUNCTION finance.guard_matriz_commission_period()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'matriz_commission_period_immutable'; END IF;
  IF ROW(NEW.environment,NEW.collaborator_id,NEW.settlement_frequency,
         NEW.period_start,NEW.period_end,NEW.sales_count,NEW.gross_sales,
         NEW.commission_amount,NEW.source_expense_id,NEW.closed_at,NEW.closed_by,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.environment,OLD.collaborator_id,OLD.settlement_frequency,
         OLD.period_start,OLD.period_end,OLD.sales_count,OLD.gross_sales,
         OLD.commission_amount,OLD.source_expense_id,OLD.closed_at,OLD.closed_by,OLD.created_at)
  THEN RAISE EXCEPTION 'matriz_commission_period_immutable'; END IF;
  IF OLD.payment_status='pending' AND NEW.payment_status='paid'
     AND OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL
     AND OLD.paid_by IS NULL AND NEW.paid_by IS NOT NULL THEN RETURN NEW; END IF;
  IF ROW(NEW.payment_status,NEW.paid_at,NEW.paid_by)
     IS NOT DISTINCT FROM ROW(OLD.payment_status,OLD.paid_at,OLD.paid_by) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'matriz_commission_period_immutable';
END;
$function$;
DROP TRIGGER IF EXISTS matriz_commission_period_immutable ON finance.matriz_commission_periods;
CREATE TRIGGER matriz_commission_period_immutable
BEFORE UPDATE OR DELETE ON finance.matriz_commission_periods
FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_commission_period();

CREATE OR REPLACE FUNCTION finance.guard_matriz_commission_expense()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM finance.matriz_commission_periods period
    WHERE period.environment=OLD.environment AND period.source_expense_id=OLD.id) THEN
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
DROP TRIGGER IF EXISTS matriz_commission_expense_locked ON commerce.matriz_expenses;
CREATE TRIGGER matriz_commission_expense_locked
BEFORE UPDATE OR DELETE ON commerce.matriz_expenses
FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_commission_expense();

CREATE OR REPLACE FUNCTION finance.sync_matriz_commission_expense_payment()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.payment_status='pending' AND NEW.payment_status='paid' THEN
    UPDATE finance.matriz_commission_periods
       SET payment_status='paid',paid_at=NEW.paid_at,
           paid_by=COALESCE(NULLIF(current_setting('app.actor_label',true),''),'financeiro:despesa')
     WHERE environment=NEW.environment AND source_expense_id=NEW.id
       AND payment_status='pending';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS matriz_commission_expense_payment_sync ON commerce.matriz_expenses;
CREATE TRIGGER matriz_commission_expense_payment_sync
AFTER UPDATE OF payment_status,paid_at ON commerce.matriz_expenses
FOR EACH ROW EXECUTE FUNCTION finance.sync_matriz_commission_expense_payment();

REVOKE ALL ON finance.matriz_commission_periods FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.snapshot_partner_staff_adjustment_frequency() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_matriz_commission_period() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_matriz_commission_expense() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.sync_matriz_commission_expense_payment() FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON finance.matriz_commission_periods FROM farejador_partner_app;
  END IF;
END;
$grants$;

COMMENT ON COLUMN network.partner_token_commission.settlement_frequency IS
  'weekly fecha domingo-sabado; monthly fecha primeiro-ultimo dia do mes.';
COMMENT ON TABLE finance.matriz_commission_periods IS
  'Fechamentos semanais imutaveis de comissao da Matriz; salario e beneficios permanecem na folha mensal.';
