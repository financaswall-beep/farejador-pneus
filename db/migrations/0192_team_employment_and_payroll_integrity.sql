-- 0192 - Integridade transversal de Equipe/Colaboradores.
-- Preserva periodos de vinculo, fecha folha apenas apos a competencia terminar,
-- carrega ajustes nao absorvidos e fixa papel/permissoes/centavos no banco.

CREATE TABLE IF NOT EXISTS network.matriz_collaborator_employment_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  collaborator_id UUID NOT NULL REFERENCES network.matriz_collaborators(id),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS matriz_collaborator_employment_open_uniq
  ON network.matriz_collaborator_employment_periods(environment,collaborator_id)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS matriz_collaborator_employment_lookup_idx
  ON network.matriz_collaborator_employment_periods(environment,collaborator_id,started_at,ended_at);

CREATE TABLE IF NOT EXISTS network.partner_collaborator_employment_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  partner_unit_id UUID NOT NULL,
  token_id UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_employment_period_unit_fk
    FOREIGN KEY (environment,partner_unit_id)
    REFERENCES network.partner_units(environment,id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_collaborator_employment_open_uniq
  ON network.partner_collaborator_employment_periods(environment,token_id)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS partner_collaborator_employment_lookup_idx
  ON network.partner_collaborator_employment_periods(environment,token_id,started_at,ended_at);

DROP TRIGGER IF EXISTS env_match_matriz_employment_collaborator
  ON network.matriz_collaborator_employment_periods;
CREATE TRIGGER env_match_matriz_employment_collaborator
BEFORE INSERT OR UPDATE OF environment,collaborator_id
ON network.matriz_collaborator_employment_periods FOR EACH ROW
EXECUTE FUNCTION ops.validate_env_match('network','matriz_collaborators','collaborator_id');

DROP TRIGGER IF EXISTS env_match_partner_employment_token
  ON network.partner_collaborator_employment_periods;
CREATE TRIGGER env_match_partner_employment_token
BEFORE INSERT OR UPDATE OF environment,token_id
ON network.partner_collaborator_employment_periods FOR EACH ROW
EXECUTE FUNCTION ops.validate_env_match('network','partner_access_tokens','token_id');

CREATE OR REPLACE FUNCTION network.guard_employment_period()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'employment_period_immutable'; END IF;
  IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
     AND (to_jsonb(NEW)-'ended_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'ended_at') THEN
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'employment_period_immutable';
END;
$function$;

DROP TRIGGER IF EXISTS guard_matriz_employment_period
  ON network.matriz_collaborator_employment_periods;
CREATE TRIGGER guard_matriz_employment_period
BEFORE UPDATE OR DELETE ON network.matriz_collaborator_employment_periods
FOR EACH ROW EXECUTE FUNCTION network.guard_employment_period();
DROP TRIGGER IF EXISTS guard_partner_employment_period
  ON network.partner_collaborator_employment_periods;
CREATE TRIGGER guard_partner_employment_period
BEFORE UPDATE OR DELETE ON network.partner_collaborator_employment_periods
FOR EACH ROW EXECUTE FUNCTION network.guard_employment_period();

INSERT INTO network.matriz_collaborator_employment_periods
  (environment,collaborator_id,started_at,ended_at)
SELECT environment,id,created_at,revoked_at
  FROM network.matriz_collaborators mc
 WHERE NOT EXISTS (
   SELECT 1 FROM network.matriz_collaborator_employment_periods ep
    WHERE ep.environment=mc.environment AND ep.collaborator_id=mc.id
 );

INSERT INTO network.partner_collaborator_employment_periods
  (environment,partner_unit_id,token_id,started_at,ended_at)
SELECT environment,partner_unit_id,id,created_at,revoked_at
  FROM network.partner_access_tokens pat
 WHERE role='funcionario'
   AND NOT EXISTS (
     SELECT 1 FROM network.partner_collaborator_employment_periods ep
      WHERE ep.environment=pat.environment AND ep.token_id=pat.id
   );

CREATE OR REPLACE FUNCTION network.track_matriz_collaborator_employment()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO network.matriz_collaborator_employment_periods
      (environment,collaborator_id,started_at,ended_at)
    VALUES (NEW.environment,NEW.id,NEW.created_at,NEW.revoked_at);
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE network.matriz_collaborator_employment_periods
       SET ended_at=NEW.revoked_at
     WHERE environment=NEW.environment AND collaborator_id=NEW.id AND ended_at IS NULL;
  ELSIF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    INSERT INTO network.matriz_collaborator_employment_periods
      (environment,collaborator_id,started_at)
    VALUES (NEW.environment,NEW.id,clock_timestamp());
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS track_matriz_collaborator_employment
  ON network.matriz_collaborators;
CREATE TRIGGER track_matriz_collaborator_employment
AFTER INSERT OR UPDATE OF revoked_at ON network.matriz_collaborators
FOR EACH ROW EXECUTE FUNCTION network.track_matriz_collaborator_employment();

CREATE OR REPLACE FUNCTION network.track_partner_collaborator_employment()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.role<>'funcionario' THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    INSERT INTO network.partner_collaborator_employment_periods
      (environment,partner_unit_id,token_id,started_at,ended_at)
    VALUES (NEW.environment,NEW.partner_unit_id,NEW.id,NEW.created_at,NEW.revoked_at);
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE network.partner_collaborator_employment_periods
       SET ended_at=NEW.revoked_at
     WHERE environment=NEW.environment AND token_id=NEW.id AND ended_at IS NULL;
  ELSIF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    INSERT INTO network.partner_collaborator_employment_periods
      (environment,partner_unit_id,token_id,started_at)
    VALUES (NEW.environment,NEW.partner_unit_id,NEW.id,clock_timestamp());
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS track_partner_collaborator_employment
  ON network.partner_access_tokens;
CREATE TRIGGER track_partner_collaborator_employment
AFTER INSERT OR UPDATE OF revoked_at ON network.partner_access_tokens
FOR EACH ROW EXECUTE FUNCTION network.track_partner_collaborator_employment();

CREATE OR REPLACE FUNCTION finance.matriz_collaborator_employed_on(
  p_environment env_t,p_collaborator_id UUID,p_date DATE
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (
    SELECT 1 FROM network.matriz_collaborator_employment_periods ep
     WHERE ep.environment=p_environment AND ep.collaborator_id=p_collaborator_id
       AND (ep.started_at AT TIME ZONE 'America/Sao_Paulo')::date<=p_date
       AND (ep.ended_at IS NULL OR (ep.ended_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_date)
  );
$function$;

CREATE OR REPLACE FUNCTION finance.matriz_collaborator_employed_in_competence(
  p_environment env_t,p_collaborator_id UUID,p_competence DATE
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (
    SELECT 1 FROM network.matriz_collaborator_employment_periods ep
     WHERE ep.environment=p_environment AND ep.collaborator_id=p_collaborator_id
       AND (ep.started_at AT TIME ZONE 'America/Sao_Paulo')::date
             <(p_competence+interval '1 month')::date
       AND (ep.ended_at IS NULL
         OR (ep.ended_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_competence)
  );
$function$;

CREATE OR REPLACE FUNCTION finance.partner_collaborator_employed_in_period(
  p_environment env_t,p_token_id UUID,p_start DATE,p_end DATE
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (
    SELECT 1 FROM network.partner_collaborator_employment_periods ep
     WHERE ep.environment=p_environment AND ep.token_id=p_token_id
       AND (ep.started_at AT TIME ZONE 'America/Sao_Paulo')::date<=p_end
       AND (ep.ended_at IS NULL
         OR (ep.ended_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_start)
  );
$function$;

ALTER TABLE network.partner_access_tokens
  ADD COLUMN IF NOT EXISTS job_role TEXT NOT NULL DEFAULT 'colaborador';
ALTER TABLE network.partner_access_tokens
  DROP CONSTRAINT IF EXISTS partner_access_tokens_job_role_check;
ALTER TABLE network.partner_access_tokens
  ADD CONSTRAINT partner_access_tokens_job_role_check
  CHECK (job_role IN ('vendedor','estoque','entregador','colaborador'));

UPDATE network.partner_access_tokens pat SET job_role=CASE
  WHEN COALESCE(ptp.allow_entregas,false) AND NOT COALESCE(ptp.allow_vendas,false) THEN 'entregador'
  WHEN COALESCE(ptp.allow_estoque,false) AND NOT COALESCE(ptp.allow_vendas,false) THEN 'estoque'
  WHEN COALESCE(ptp.allow_vendas,false) THEN 'vendedor'
  ELSE 'colaborador' END
FROM network.partner_token_permissions ptp
WHERE pat.id=ptp.token_id AND pat.environment=ptp.environment AND pat.role='funcionario';

-- Perfis antigos passam a possuir uma decisao explicita. A ausencia futura de
-- linha deixa de conceder qualquer modulo por acidente.
INSERT INTO network.partner_token_permissions
  (token_id,environment,partner_unit_id,allow_vendas,allow_estoque,allow_pedidos,
   allow_clientes,allow_entregas,allow_retiradas,allow_batepapo,allow_resumo,
   allow_financeiro,updated_by)
SELECT pat.id,pat.environment,pat.partner_unit_id,false,false,false,false,false,
       false,false,false,false,'migration:0192-fail-closed'
  FROM network.partner_access_tokens pat
 WHERE pat.role='funcionario'
   AND NOT EXISTS (SELECT 1 FROM network.partner_token_permissions ptp
                    WHERE ptp.environment=pat.environment AND ptp.token_id=pat.id);

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
           OR (item->>'amount')::numeric<>round((item->>'amount')::numeric,2)
           OR (item ? 'active' AND jsonb_typeof(item->'active')<>'boolean')
     );
$function$;

CREATE OR REPLACE FUNCTION finance.guard_matriz_payroll_completed_competence()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.competence>=date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'payroll_competence_not_finished';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS matriz_payroll_completed_competence
  ON finance.matriz_payroll_periods;
CREATE TRIGGER matriz_payroll_completed_competence
BEFORE INSERT OR UPDATE OF competence ON finance.matriz_payroll_periods
FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_payroll_completed_competence();

CREATE TABLE IF NOT EXISTS finance.matriz_payroll_adjustment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  adjustment_id UUID NOT NULL REFERENCES finance.matriz_payroll_adjustments(id),
  payroll_item_id UUID NOT NULL REFERENCES finance.matriz_payroll_items(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (adjustment_id,payroll_item_id)
);
CREATE INDEX IF NOT EXISTS matriz_payroll_adjustment_allocations_lookup_idx
  ON finance.matriz_payroll_adjustment_allocations(environment,adjustment_id);

DROP TRIGGER IF EXISTS env_match_matriz_allocation_adjustment
  ON finance.matriz_payroll_adjustment_allocations;
CREATE TRIGGER env_match_matriz_allocation_adjustment
BEFORE INSERT OR UPDATE OF environment,adjustment_id
ON finance.matriz_payroll_adjustment_allocations FOR EACH ROW
EXECUTE FUNCTION ops.validate_env_match('finance','matriz_payroll_adjustments','adjustment_id');
DROP TRIGGER IF EXISTS env_match_matriz_allocation_item
  ON finance.matriz_payroll_adjustment_allocations;
CREATE TRIGGER env_match_matriz_allocation_item
BEFORE INSERT OR UPDATE OF environment,payroll_item_id
ON finance.matriz_payroll_adjustment_allocations FOR EACH ROW
EXECUTE FUNCTION ops.validate_env_match('finance','matriz_payroll_items','payroll_item_id');

CREATE OR REPLACE FUNCTION finance.guard_matriz_payroll_allocation()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE v_adjustment RECORD; v_item RECORD; v_used NUMERIC(12,2);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'payroll_adjustment_allocation_immutable'; END IF;
  SELECT environment,collaborator_id,amount INTO v_adjustment
    FROM finance.matriz_payroll_adjustments WHERE id=NEW.adjustment_id FOR UPDATE;
  SELECT environment,collaborator_id INTO v_item
    FROM finance.matriz_payroll_items WHERE id=NEW.payroll_item_id;
  IF v_adjustment.environment IS DISTINCT FROM NEW.environment
     OR v_item.environment IS DISTINCT FROM NEW.environment
     OR v_adjustment.collaborator_id IS DISTINCT FROM v_item.collaborator_id THEN
    RAISE EXCEPTION 'payroll_adjustment_allocation_mismatch';
  END IF;
  SELECT COALESCE(sum(amount),0) INTO v_used
    FROM finance.matriz_payroll_adjustment_allocations
   WHERE environment=NEW.environment AND adjustment_id=NEW.adjustment_id;
  IF v_used+NEW.amount>v_adjustment.amount THEN
    RAISE EXCEPTION 'payroll_adjustment_overallocated';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_matriz_payroll_allocation
  ON finance.matriz_payroll_adjustment_allocations;
CREATE TRIGGER guard_matriz_payroll_allocation
BEFORE INSERT OR UPDATE OR DELETE ON finance.matriz_payroll_adjustment_allocations
FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_payroll_allocation();

CREATE OR REPLACE FUNCTION finance.allocate_matriz_payroll_adjustments(
  p_environment env_t,p_collaborator_id UUID,p_payroll_item_id UUID,
  p_kind TEXT,p_amount NUMERIC
) RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,finance AS $function$
DECLARE v_row RECORD; v_left NUMERIC(12,2):=round(GREATEST(p_amount,0),2);
  v_take NUMERIC(12,2); v_allocated NUMERIC(12,2):=0; v_competence DATE;
BEGIN
  IF p_kind NOT IN ('addition','deduction') THEN RAISE EXCEPTION 'invalid_adjustment_kind'; END IF;
  SELECT p.competence INTO v_competence
    FROM finance.matriz_payroll_items i
    JOIN finance.matriz_payroll_periods p ON p.id=i.payroll_period_id AND p.environment=i.environment
   WHERE i.id=p_payroll_item_id AND i.environment=p_environment
     AND i.collaborator_id=p_collaborator_id;
  IF v_competence IS NULL THEN RAISE EXCEPTION 'payroll_item_not_found'; END IF;
  FOR v_row IN
    SELECT a.id,a.amount-COALESCE(sum(al.amount),0) remaining
      FROM finance.matriz_payroll_adjustments a
      LEFT JOIN finance.matriz_payroll_adjustment_allocations al
        ON al.environment=a.environment AND al.adjustment_id=a.id
     WHERE a.environment=p_environment AND a.collaborator_id=p_collaborator_id
       AND a.kind=p_kind AND a.competence<=v_competence AND a.deleted_at IS NULL
       AND COALESCE(a.causal_status,'ready')<>'needs_review'
     GROUP BY a.id,a.amount,a.competence,a.created_at
    HAVING a.amount-COALESCE(sum(al.amount),0)>0
     ORDER BY a.competence,a.created_at,a.id
  LOOP
    EXIT WHEN v_left<=0;
    v_take:=LEAST(v_left,v_row.remaining);
    INSERT INTO finance.matriz_payroll_adjustment_allocations
      (environment,adjustment_id,payroll_item_id,amount)
    VALUES (p_environment,v_row.id,p_payroll_item_id,v_take);
    v_left:=v_left-v_take; v_allocated:=v_allocated+v_take;
  END LOOP;
  RETURN v_allocated;
END;
$function$;

-- Recalcula lacunas somente quando havia, na data do evento, colaborador
-- contratado e elegivel para aquela base de comissao.
CREATE OR REPLACE FUNCTION finance.matriz_payroll_assignment_gaps(
  p_environment env_t,p_competence DATE
) RETURNS TABLE(event_type TEXT,missing_count INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,finance,commerce,network,core AS $function$
  WITH events AS (
    SELECT 'sale'::text event_type,(o.created_at AT TIME ZONE 'America/Sao_Paulo')::date event_date
      FROM commerce.orders o JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
     WHERE o.environment=p_environment AND o.status<>'cancelled' AND o.seller_collaborator_id IS NULL
       AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_competence
       AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date<(p_competence+interval '1 month')::date
    UNION ALL
    SELECT 'sale',(o.created_at AT TIME ZONE 'America/Sao_Paulo')::date
      FROM commerce.wholesale_orders o
     WHERE o.environment=p_environment AND o.status='confirmed' AND o.seller_collaborator_id IS NULL
       AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_competence
       AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date<(p_competence+interval '1 month')::date
    UNION ALL
    SELECT 'delivery',(o.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date
      FROM commerce.orders o LEFT JOIN commerce.matriz_delivery_trips t
        ON t.id=o.trip_id AND t.environment=o.environment AND t.deleted_at IS NULL
     WHERE o.environment=p_environment AND o.status<>'cancelled' AND o.delivery_status='delivered'
       AND o.delivered_at IS NOT NULL AND t.courier_collaborator_id IS NULL
       AND (o.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_competence
       AND (o.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date<(p_competence+interval '1 month')::date
    UNION ALL
    SELECT 'trip',(t.ended_at AT TIME ZONE 'America/Sao_Paulo')::date
      FROM commerce.matriz_delivery_trips t
     WHERE t.environment=p_environment AND t.deleted_at IS NULL AND t.status='closed'
       AND t.ended_at IS NOT NULL AND t.courier_collaborator_id IS NULL
       AND commerce.matriz_trip_financial_status(t.id,t.environment)='reconciled'
       AND (t.ended_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_competence
       AND (t.ended_at AT TIME ZONE 'America/Sao_Paulo')::date<(p_competence+interval '1 month')::date
  )
  SELECT e.event_type,count(*)::int FROM events e
   WHERE EXISTS (
     SELECT 1 FROM network.matriz_collaborators mc
     JOIN LATERAL (
       SELECT r.basis,r.active FROM network.matriz_collaborator_commission_rules r
        WHERE r.environment=mc.environment AND r.collaborator_id=mc.id AND r.starts_on<=e.event_date
        ORDER BY r.starts_on DESC LIMIT 1
     ) rule ON true
     WHERE mc.environment=p_environment
       AND finance.matriz_collaborator_employed_on(p_environment,mc.id,e.event_date)
       AND rule.active AND ((e.event_type='sale' AND rule.basis IN ('margin','revenue','sale'))
         OR (e.event_type='delivery' AND rule.basis='delivery')
         OR (e.event_type='trip' AND rule.basis='trip'))
   ) GROUP BY e.event_type ORDER BY e.event_type;
$function$;

REVOKE ALL ON network.matriz_collaborator_employment_periods FROM PUBLIC;
REVOKE ALL ON network.partner_collaborator_employment_periods FROM PUBLIC;
REVOKE ALL ON finance.matriz_payroll_adjustment_allocations FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.allocate_matriz_payroll_adjustments(env_t,uuid,uuid,text,numeric) FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON network.matriz_collaborator_employment_periods FROM farejador_partner_app;
    REVOKE ALL ON network.partner_collaborator_employment_periods FROM farejador_partner_app;
    REVOKE ALL ON finance.matriz_payroll_adjustment_allocations FROM farejador_partner_app;
  END IF;
END
$security$;
