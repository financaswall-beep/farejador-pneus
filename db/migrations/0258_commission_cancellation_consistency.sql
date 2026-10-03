BEGIN;
-- Exact frozen facts for new settlements; preserve legacy closed-period behavior.
CREATE OR REPLACE FUNCTION finance.queue_matriz_order_cancellation_adjustments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance, commerce, network
AS $fn$
DECLARE
  v_item_id UUID;
  v_rule RECORD;
  v_event_date DATE;
  v_amount NUMERIC;
  v_margin NUMERIC;
  v_missing_cost INTEGER;
  v_courier_id UUID;
BEGIN
  IF NEW.status <> 'cancelled' OR OLD.status='cancelled' THEN RETURN NEW; END IF;
  PERFORM finance.reverse_matriz_commission_facts(OLD.environment,OLD.id,ARRAY['retail','delivery']);

  IF OLD.seller_collaborator_id IS NOT NULL THEN
    v_event_date := (OLD.created_at AT TIME ZONE 'America/Sao_Paulo')::date;
    SELECT i.id INTO v_item_id
      FROM finance.matriz_payroll_items i
      JOIN finance.matriz_payroll_periods p ON p.id=i.payroll_period_id
     WHERE i.environment=OLD.environment
       AND i.collaborator_id=OLD.seller_collaborator_id
       AND p.competence=date_trunc('month',v_event_date)::date
       AND OLD.created_at<=p.closed_at
       AND EXISTS (SELECT 1 FROM finance.matriz_commission_legacy_periods legacy
         WHERE legacy.environment=i.environment AND legacy.target_id=i.id);
    IF v_item_id IS NOT NULL THEN
      SELECT r.id,r.kind,r.basis,r.value INTO v_rule
        FROM network.matriz_collaborator_commission_rules r
       WHERE r.environment=OLD.environment
         AND r.collaborator_id=OLD.seller_collaborator_id
         AND r.starts_on<=v_event_date AND r.active
       ORDER BY r.starts_on DESC LIMIT 1;
      v_amount := NULL;
      v_margin := NULL;
      v_missing_cost := 0;
      IF v_rule.id IS NOT NULL AND v_rule.kind='fixed' AND v_rule.basis='sale' THEN
        v_amount := v_rule.value;
      ELSIF v_rule.id IS NOT NULL AND v_rule.kind='percent' AND v_rule.basis='revenue' THEN
        v_amount := OLD.total_amount*v_rule.value/100;
      ELSIF v_rule.id IS NOT NULL AND v_rule.kind='percent' AND v_rule.basis='margin' THEN
        SELECT COALESCE(sum((oi.unit_price-oi.matriz_unit_cost)*oi.quantity-oi.discount_amount)
                   FILTER (WHERE oi.matriz_unit_cost IS NOT NULL),0),
               count(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int
          INTO v_margin,v_missing_cost
          FROM commerce.order_items oi
         WHERE oi.order_id=OLD.id AND oi.environment=OLD.environment;
        IF v_missing_cost=0 THEN v_amount := v_margin*v_rule.value/100; END IF;
      END IF;
      IF v_rule.id IS NOT NULL THEN
        PERFORM finance.insert_matriz_causal_adjustment(
          OLD.environment,OLD.seller_collaborator_id,'retail_sale_cancellation',OLD.id,
          OLD.created_at,v_item_id,v_amount,
          jsonb_build_object('event','sale','rule_id',v_rule.id,'kind',v_rule.kind,
            'basis',v_rule.basis,'value',v_rule.value,'revenue',OLD.total_amount,
            'margin',v_margin,'items_without_cost',v_missing_cost));
      END IF;
    END IF;
  END IF;

  IF OLD.delivery_status='delivered' AND OLD.delivered_at IS NOT NULL AND OLD.trip_id IS NOT NULL THEN
    SELECT t.courier_collaborator_id INTO v_courier_id
      FROM commerce.matriz_delivery_trips t
     WHERE t.id=OLD.trip_id AND t.environment=OLD.environment;
    IF v_courier_id IS NOT NULL THEN
      v_event_date := (OLD.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date;
      v_item_id := NULL;
      SELECT i.id INTO v_item_id
        FROM finance.matriz_payroll_items i
        JOIN finance.matriz_payroll_periods p ON p.id=i.payroll_period_id
       WHERE i.environment=OLD.environment AND i.collaborator_id=v_courier_id
         AND p.competence=date_trunc('month',v_event_date)::date
         AND OLD.delivered_at<=p.closed_at
         AND EXISTS (SELECT 1 FROM finance.matriz_commission_legacy_periods legacy
           WHERE legacy.environment=i.environment AND legacy.target_id=i.id);
      IF v_item_id IS NOT NULL THEN
        v_rule := NULL;
        SELECT r.id,r.kind,r.basis,r.value INTO v_rule
          FROM network.matriz_collaborator_commission_rules r
         WHERE r.environment=OLD.environment AND r.collaborator_id=v_courier_id
           AND r.starts_on<=v_event_date AND r.active
         ORDER BY r.starts_on DESC LIMIT 1;
        IF v_rule.id IS NOT NULL AND v_rule.kind='fixed' AND v_rule.basis='delivery' THEN
          PERFORM finance.insert_matriz_causal_adjustment(
            OLD.environment,v_courier_id,'delivery_cancellation',OLD.id,OLD.delivered_at,
            v_item_id,v_rule.value,
            jsonb_build_object('event','delivery','rule_id',v_rule.id,'kind',v_rule.kind,
              'basis',v_rule.basis,'value',v_rule.value,'trip_id',OLD.trip_id));
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION finance.queue_matriz_wholesale_cancellation_adjustment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance, commerce, network
AS $fn$
DECLARE
  v_item_id UUID;
  v_rule RECORD;
  v_event_date DATE;
  v_amount NUMERIC;
  v_margin NUMERIC;
BEGIN
  IF NEW.status <> 'cancelled' OR OLD.status='cancelled' THEN RETURN NEW; END IF;
  PERFORM finance.reverse_matriz_commission_facts(OLD.environment,OLD.id,ARRAY['wholesale']);
  IF OLD.seller_collaborator_id IS NULL THEN RETURN NEW; END IF;
  v_event_date := ((CASE WHEN OLD.partner_transfer_status IN ('settled','received')
    THEN COALESCE(OLD.partner_settled_at,OLD.sold_at) ELSE OLD.sold_at END) AT TIME ZONE 'America/Sao_Paulo')::date;
  SELECT i.id INTO v_item_id
    FROM finance.matriz_payroll_items i
    JOIN finance.matriz_payroll_periods p ON p.id=i.payroll_period_id
   WHERE i.environment=OLD.environment
     AND i.collaborator_id=OLD.seller_collaborator_id
     AND p.competence=date_trunc('month',v_event_date)::date
     AND OLD.created_at<=p.closed_at
     AND EXISTS (SELECT 1 FROM finance.matriz_commission_legacy_periods legacy
       WHERE legacy.environment=i.environment AND legacy.target_id=i.id);
  IF v_item_id IS NULL THEN RETURN NEW; END IF;
  SELECT r.id,r.kind,r.basis,r.value INTO v_rule
    FROM network.matriz_collaborator_commission_rules r
   WHERE r.environment=OLD.environment
     AND r.collaborator_id=OLD.seller_collaborator_id
     AND r.starts_on<=v_event_date AND r.active
   ORDER BY r.starts_on DESC LIMIT 1;
  IF v_rule.id IS NULL THEN RETURN NEW; END IF;
  IF v_rule.kind='fixed' AND v_rule.basis='sale' THEN
    v_amount := v_rule.value;
  ELSIF v_rule.kind='percent' AND v_rule.basis='revenue' THEN
    v_amount := OLD.total_amount*v_rule.value/100;
  ELSIF v_rule.kind='percent' AND v_rule.basis='margin' THEN
    SELECT COALESCE(sum((oi.unit_price-oi.unit_cost)*oi.quantity),0)
      INTO v_margin FROM commerce.wholesale_order_items oi
     WHERE oi.order_id=OLD.id AND oi.environment=OLD.environment;
    v_amount := v_margin*v_rule.value/100;
  ELSE
    RETURN NEW;
  END IF;
  PERFORM finance.insert_matriz_causal_adjustment(
    OLD.environment,OLD.seller_collaborator_id,'wholesale_sale_cancellation',OLD.id,
    OLD.created_at,v_item_id,v_amount,
    jsonb_build_object('event','sale','channel','wholesale','rule_id',v_rule.id,
      'kind',v_rule.kind,'basis',v_rule.basis,'value',v_rule.value,
      'revenue',OLD.total_amount,'margin',v_margin));
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION finance.guard_matriz_commission_period()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'matriz_commission_period_immutable'; END IF;
  IF ROW(NEW.environment,NEW.collaborator_id,NEW.settlement_frequency,
         NEW.period_start,NEW.period_end,NEW.sales_count,NEW.gross_sales,
         NEW.earned_amount,NEW.deductions,NEW.commission_amount,NEW.source_expense_id,NEW.closed_at,NEW.closed_by,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.environment,OLD.collaborator_id,OLD.settlement_frequency,
         OLD.period_start,OLD.period_end,OLD.sales_count,OLD.gross_sales,
         OLD.earned_amount,OLD.deductions,OLD.commission_amount,OLD.source_expense_id,OLD.closed_at,OLD.closed_by,OLD.created_at)
  THEN RAISE EXCEPTION 'matriz_commission_period_immutable'; END IF;
  IF OLD.payment_status='pending' AND NEW.payment_status='paid'
     AND OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL
     AND OLD.paid_by IS NULL AND NEW.paid_by IS NOT NULL THEN RETURN NEW; END IF;
  IF ROW(NEW.payment_status,NEW.paid_at,NEW.paid_by)
     IS NOT DISTINCT FROM ROW(OLD.payment_status,OLD.paid_at,OLD.paid_by) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'matriz_commission_period_immutable';
END;
$function$;

CREATE OR REPLACE FUNCTION finance.protect_matriz_causal_adjustment()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.source_type IS NULL THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'causal_adjustment_immutable';
  END IF;
  IF OLD.causal_status='needs_review'
     AND NEW.causal_status='ready'
     AND NEW.amount > 0
     AND NEW.reviewed_at IS NOT NULL
     AND length(btrim(NEW.reviewed_by)) BETWEEN 2 AND 160
     AND NEW.environment IS NOT DISTINCT FROM OLD.environment
     AND NEW.collaborator_id IS NOT DISTINCT FROM OLD.collaborator_id
     AND NEW.competence IS NOT DISTINCT FROM OLD.competence
     AND NEW.kind IS NOT DISTINCT FROM OLD.kind
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
     AND NEW.source_type IS NOT DISTINCT FROM OLD.source_type
     AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
     AND NEW.source_event_at IS NOT DISTINCT FROM OLD.source_event_at
     AND NEW.original_commission_period_id IS NOT DISTINCT FROM OLD.original_commission_period_id
     AND NEW.original_payroll_item_id IS NOT DISTINCT FROM OLD.original_payroll_item_id
     AND NEW.frozen_calculation IS NOT DISTINCT FROM OLD.frozen_calculation
     AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key THEN
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'causal_adjustment_immutable';
END
$fn$;

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
       AND a.original_commission_period_id IS NULL
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
    SELECT 'sale',((CASE WHEN o.partner_transfer_status IN ('settled','received') THEN COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END) AT TIME ZONE 'America/Sao_Paulo')::date
      FROM commerce.wholesale_orders o
     WHERE o.environment=p_environment AND o.status='confirmed' AND (o.partner_transfer_status IS NULL OR o.partner_transfer_status IN ('settled','received')) AND o.seller_collaborator_id IS NULL
       AND ((CASE WHEN o.partner_transfer_status IN ('settled','received') THEN COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END) AT TIME ZONE 'America/Sao_Paulo')::date>=p_competence
       AND ((CASE WHEN o.partner_transfer_status IN ('settled','received') THEN COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END) AT TIME ZONE 'America/Sao_Paulo')::date<(p_competence+interval '1 month')::date
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

CREATE FUNCTION finance.prepare_matriz_commission_amount() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.earned_amount:=COALESCE(NEW.earned_amount,NEW.commission_amount+NEW.deductions); RETURN NEW; END $$;
CREATE TRIGGER prepare_matriz_commission_amount BEFORE INSERT ON finance.matriz_commission_periods
  FOR EACH ROW EXECUTE FUNCTION finance.prepare_matriz_commission_amount();
REVOKE ALL ON FUNCTION finance.prepare_matriz_commission_amount() FROM PUBLIC;
DO $smoke$ BEGIN
  IF position('reverse_matriz_commission_facts' IN pg_get_functiondef(
      'finance.queue_matriz_wholesale_cancellation_adjustment()'::regprocedure))=0
    OR position('earned_amount' IN pg_get_functiondef('finance.guard_matriz_commission_period()'::regprocedure))=0 THEN
    RAISE EXCEPTION '0258: guardas de comissao incompletas';
  END IF;
END $smoke$;
COMMIT;
