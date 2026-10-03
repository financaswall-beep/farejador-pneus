BEGIN;
-- Closed payrolls remain immutable. New settlements identify their actual facts.
CREATE TABLE finance.matriz_commission_legacy_periods (
  environment env_t NOT NULL, target_id uuid NOT NULL,
  collaborator_id uuid NOT NULL, frequency text NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL, closed_at timestamptz NOT NULL,
  PRIMARY KEY(environment,target_id)
);
INSERT INTO finance.matriz_commission_legacy_periods
SELECT i.environment,i.id,i.collaborator_id,'monthly',p.competence,
       (p.competence+interval '1 month' - interval '1 day')::date,p.closed_at
FROM finance.matriz_payroll_items i JOIN finance.matriz_payroll_periods p
  ON p.environment=i.environment AND p.id=i.payroll_period_id
UNION ALL
SELECT environment,id,collaborator_id,'weekly',period_start,period_end,closed_at
FROM finance.matriz_commission_periods;

CREATE FUNCTION finance.protect_commission_legacy_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'commission_legacy_snapshot_immutable'; END $$;
CREATE TRIGGER protect_commission_legacy_snapshot BEFORE INSERT OR UPDATE OR DELETE
  ON finance.matriz_commission_legacy_periods FOR EACH ROW EXECUTE FUNCTION finance.protect_commission_legacy_snapshot();
REVOKE ALL ON FUNCTION finance.protect_commission_legacy_snapshot() FROM PUBLIC;

CREATE TABLE finance.matriz_commission_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment env_t NOT NULL,
  collaborator_id uuid NOT NULL REFERENCES network.matriz_collaborators(id),
  source_type text NOT NULL CHECK(source_type IN ('retail','wholesale','delivery','trip')),
  source_id uuid NOT NULL, occurred_at timestamptz NOT NULL,
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  payroll_item_id uuid REFERENCES finance.matriz_payroll_items(id),
  commission_period_id uuid REFERENCES finance.matriz_commission_periods(id),
  calculation jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(num_nonnulls(payroll_item_id,commission_period_id)=1),
  UNIQUE(environment,source_type,source_id,collaborator_id)
);
CREATE INDEX matriz_commission_facts_targets_idx ON finance.matriz_commission_facts
  (environment,collaborator_id,payroll_item_id,commission_period_id);

CREATE FUNCTION finance.guard_matriz_commission_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_target record; v_source_env env_t;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'commission_fact_immutable'; END IF;
  IF NEW.payroll_item_id IS NOT NULL THEN
    SELECT environment,collaborator_id INTO v_target FROM finance.matriz_payroll_items WHERE id=NEW.payroll_item_id;
  ELSE
    SELECT environment,collaborator_id INTO v_target FROM finance.matriz_commission_periods WHERE id=NEW.commission_period_id;
  END IF;
  IF v_target.environment IS DISTINCT FROM NEW.environment
     OR v_target.collaborator_id IS DISTINCT FROM NEW.collaborator_id THEN
    RAISE EXCEPTION 'commission_fact_target_mismatch';
  END IF;
  IF NEW.source_type='wholesale' THEN
    SELECT environment INTO v_source_env FROM commerce.wholesale_orders WHERE id=NEW.source_id;
  ELSIF NEW.source_type='trip' THEN
    SELECT environment INTO v_source_env FROM commerce.matriz_delivery_trips WHERE id=NEW.source_id;
  ELSE
    SELECT environment INTO v_source_env FROM commerce.orders WHERE id=NEW.source_id;
  END IF;
  IF v_source_env IS DISTINCT FROM NEW.environment THEN RAISE EXCEPTION 'commission_fact_source_mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_matriz_commission_fact BEFORE INSERT OR UPDATE OR DELETE
  ON finance.matriz_commission_facts FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_commission_fact();

ALTER TABLE finance.matriz_commission_periods
  ADD COLUMN earned_amount numeric(14,2), ADD COLUMN deductions numeric(14,2) NOT NULL DEFAULT 0;
UPDATE finance.matriz_commission_periods SET earned_amount=commission_amount;
ALTER TABLE finance.matriz_commission_periods ALTER COLUMN earned_amount SET NOT NULL,
  ALTER COLUMN source_expense_id DROP NOT NULL,
  DROP CONSTRAINT matriz_commission_periods_commission_amount_check,
  ADD CHECK(commission_amount>=0 AND earned_amount>=0 AND deductions>=0
    AND commission_amount=earned_amount-deductions),
  ADD CHECK((commission_amount=0 AND source_expense_id IS NULL AND payment_status='paid')
    OR (commission_amount>0 AND source_expense_id IS NOT NULL));

ALTER TABLE finance.matriz_payroll_adjustments ADD COLUMN original_commission_period_id uuid
  REFERENCES finance.matriz_commission_periods(id);
CREATE TRIGGER env_match_matriz_adjustment_original_week
  BEFORE INSERT OR UPDATE OF environment,original_commission_period_id ON finance.matriz_payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('finance','matriz_commission_periods','original_commission_period_id');
ALTER TABLE finance.matriz_payroll_adjustments DROP CONSTRAINT matriz_payroll_adjustments_causal_metadata_check;
ALTER TABLE finance.matriz_payroll_adjustments ADD CONSTRAINT matriz_payroll_adjustments_causal_metadata_check CHECK (
  (source_type IS NULL AND source_id IS NULL AND source_event_at IS NULL
    AND original_payroll_item_id IS NULL AND original_commission_period_id IS NULL
    AND frozen_calculation IS NULL AND idempotency_key IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
  OR (source_type IN ('retail_sale_cancellation','wholesale_sale_cancellation','delivery_cancellation')
    AND source_id IS NOT NULL AND source_event_at IS NOT NULL
    AND num_nonnulls(original_payroll_item_id,original_commission_period_id)=1
    AND frozen_calculation IS NOT NULL AND length(idempotency_key) BETWEEN 8 AND 200
    AND ((causal_status='needs_review' AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR (causal_status='ready' AND ((reviewed_by IS NULL AND reviewed_at IS NULL)
        OR (length(btrim(reviewed_by)) BETWEEN 2 AND 160 AND reviewed_at IS NOT NULL)))))
);
ALTER TABLE finance.matriz_payroll_adjustment_allocations
  ALTER COLUMN payroll_item_id DROP NOT NULL,
  ADD COLUMN commission_period_id uuid REFERENCES finance.matriz_commission_periods(id),
  ADD CHECK(num_nonnulls(payroll_item_id,commission_period_id)=1),
  ADD UNIQUE(adjustment_id,commission_period_id);
CREATE TRIGGER env_match_matriz_allocation_week
  BEFORE INSERT OR UPDATE OF environment,commission_period_id ON finance.matriz_payroll_adjustment_allocations
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('finance','matriz_commission_periods','commission_period_id');

CREATE OR REPLACE FUNCTION finance.guard_matriz_payroll_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_adjustment record; v_item record; v_used numeric;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'payroll_adjustment_allocation_immutable'; END IF;
  SELECT environment,collaborator_id,amount INTO v_adjustment
    FROM finance.matriz_payroll_adjustments WHERE id=NEW.adjustment_id FOR UPDATE;
  IF NEW.payroll_item_id IS NOT NULL THEN
    SELECT environment,collaborator_id INTO v_item FROM finance.matriz_payroll_items WHERE id=NEW.payroll_item_id;
  ELSE
    SELECT environment,collaborator_id INTO v_item FROM finance.matriz_commission_periods WHERE id=NEW.commission_period_id;
  END IF;
  IF v_adjustment.environment IS DISTINCT FROM NEW.environment OR v_item.environment IS DISTINCT FROM NEW.environment
    OR v_adjustment.collaborator_id IS DISTINCT FROM v_item.collaborator_id THEN
    RAISE EXCEPTION 'payroll_adjustment_allocation_mismatch';
  END IF;
  SELECT COALESCE(sum(amount),0) INTO v_used FROM finance.matriz_payroll_adjustment_allocations
    WHERE environment=NEW.environment AND adjustment_id=NEW.adjustment_id;
  IF v_used+NEW.amount>v_adjustment.amount THEN RAISE EXCEPTION 'payroll_adjustment_overallocated'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION finance.reverse_matriz_commission_facts(p_environment env_t,p_source_id uuid,p_types text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE f record; v_competence date; v_id uuid;
BEGIN
  FOR f IN SELECT * FROM finance.matriz_commission_facts
    WHERE environment=p_environment AND source_id=p_source_id AND source_type=ANY(p_types)
      AND amount>0 ORDER BY id
  LOOP
    v_competence:=finance.next_open_matriz_payroll_competence(p_environment,
      (now() AT TIME ZONE 'America/Sao_Paulo')::date);
    INSERT INTO finance.matriz_payroll_adjustments
      (environment,collaborator_id,competence,kind,description,amount,created_by,
       source_type,source_id,source_event_at,original_payroll_item_id,original_commission_period_id,
       frozen_calculation,causal_status,idempotency_key)
    VALUES (p_environment,f.collaborator_id,v_competence,'deduction',
      'Estorno de comissão por cancelamento',f.amount,'system:commission-reversal',
      CASE f.source_type WHEN 'retail' THEN 'retail_sale_cancellation'
        WHEN 'wholesale' THEN 'wholesale_sale_cancellation' ELSE 'delivery_cancellation' END,
      f.source_id,f.occurred_at,f.payroll_item_id,f.commission_period_id,
      jsonb_build_object('commission_fact_id',f.id,'frozen_fact',f.calculation),
      'ready','commission-reversal:'||f.id::text)
    ON CONFLICT (environment,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,idempotency_key,payload_after)
      VALUES (p_environment::text,'matriz_payroll','finance.matriz_payroll_adjustments',v_id,
        'causal_adjustment_created',COALESCE(NULLIF(current_setting('app.actor_label',true),''),'system:commission-reversal'),
        'commission-reversal:'||f.id::text,jsonb_build_object('amount',f.amount,'commission_fact_id',f.id));
    END IF;
  END LOOP;
END $$;

ALTER TABLE finance.matriz_commission_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.matriz_commission_legacy_periods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON finance.matriz_commission_facts,finance.matriz_commission_legacy_periods FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_matriz_commission_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.reverse_matriz_commission_facts(env_t,uuid,text[]) FROM PUBLIC;
DO $smoke$ BEGIN
  IF (SELECT count(*) FROM finance.matriz_commission_legacy_periods)
      <> (SELECT count(*) FROM finance.matriz_payroll_items)+(SELECT count(*) FROM finance.matriz_commission_periods)
    OR to_regprocedure('finance.reverse_matriz_commission_facts(env_t,uuid,text[])') IS NULL THEN
    RAISE EXCEPTION '0257: preservacao dos fechamentos incompleta';
  END IF;
END $smoke$;
COMMIT;
