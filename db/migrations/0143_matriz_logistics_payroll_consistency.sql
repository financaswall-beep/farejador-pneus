-- 0143 - Etapa 10: consistencia de rotas e snapshots/ajustes causais da folha.
-- Aditiva sobre 0142. Nao altera fuel_expense_id (congelado pela 0140), nao
-- toca network.commission_entries e nao concede acesso ao app do parceiro.

-- A confirmacao e somente a decisao owner sobre uma divergencia conhecida.
-- O estado financeiro continua derivado dos comprovantes aprovados vivos.
ALTER TABLE commerce.matriz_delivery_trips
  ADD COLUMN IF NOT EXISTS fuel_divergence_confirmed_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS fuel_divergence_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fuel_divergence_confirmed_by TEXT;

ALTER TABLE commerce.matriz_delivery_trips
  DROP CONSTRAINT IF EXISTS matriz_trip_fuel_divergence_confirmation_check;
ALTER TABLE commerce.matriz_delivery_trips
  ADD CONSTRAINT matriz_trip_fuel_divergence_confirmation_check CHECK (
    (fuel_divergence_confirmed_amount IS NULL
      AND fuel_divergence_confirmed_at IS NULL
      AND fuel_divergence_confirmed_by IS NULL)
    OR
    (fuel_divergence_confirmed_amount IS NOT NULL
      AND fuel_divergence_confirmed_amount >= 0
      AND fuel_divergence_confirmed_at IS NOT NULL
      AND length(btrim(fuel_divergence_confirmed_by)) BETWEEN 2 AND 160)
  );

COMMENT ON COLUMN commerce.matriz_delivery_trips.fuel_divergence_confirmed_amount IS
  '0143: valor oficial aprovado que o owner confirmou apesar de divergir da anotacao fuel_spent. Nunca e vinculo de despesa.';

-- A tabela de ajustes da 0133 absorve causalidade; nao nasce um segundo livro.
ALTER TABLE finance.matriz_payroll_adjustments
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id UUID,
  ADD COLUMN IF NOT EXISTS source_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS original_payroll_item_id UUID REFERENCES finance.matriz_payroll_items(id),
  ADD COLUMN IF NOT EXISTS frozen_calculation JSONB,
  ADD COLUMN IF NOT EXISTS causal_status TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE finance.matriz_payroll_adjustments
  ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE finance.matriz_payroll_adjustments
  DROP CONSTRAINT IF EXISTS matriz_payroll_adjustments_amount_check;
ALTER TABLE finance.matriz_payroll_adjustments
  DROP CONSTRAINT IF EXISTS matriz_payroll_adjustments_amount_causal_check;
ALTER TABLE finance.matriz_payroll_adjustments
  ADD CONSTRAINT matriz_payroll_adjustments_amount_causal_check CHECK (
    (source_type IS NULL AND causal_status IS NULL AND amount IS NOT NULL AND amount > 0)
    OR
    (source_type IS NOT NULL AND causal_status = 'ready' AND amount IS NOT NULL AND amount > 0)
    OR
    (source_type IS NOT NULL AND causal_status = 'needs_review' AND amount IS NULL)
  );

ALTER TABLE finance.matriz_payroll_adjustments
  DROP CONSTRAINT IF EXISTS matriz_payroll_adjustments_causal_metadata_check;
ALTER TABLE finance.matriz_payroll_adjustments
  ADD CONSTRAINT matriz_payroll_adjustments_causal_metadata_check CHECK (
    (source_type IS NULL
      AND source_id IS NULL
      AND source_event_at IS NULL
      AND original_payroll_item_id IS NULL
      AND frozen_calculation IS NULL
      AND idempotency_key IS NULL
      AND reviewed_by IS NULL
      AND reviewed_at IS NULL)
    OR
    (source_type IN ('retail_sale_cancellation','wholesale_sale_cancellation','delivery_cancellation')
      AND source_id IS NOT NULL
      AND source_event_at IS NOT NULL
      AND original_payroll_item_id IS NOT NULL
      AND frozen_calculation IS NOT NULL
      AND length(idempotency_key) BETWEEN 8 AND 200
      AND ((causal_status = 'needs_review' AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR (causal_status = 'ready'
          AND ((reviewed_by IS NULL AND reviewed_at IS NULL)
            OR (length(btrim(reviewed_by)) BETWEEN 2 AND 160 AND reviewed_at IS NOT NULL)))))
  );

CREATE UNIQUE INDEX IF NOT EXISTS matriz_payroll_adjustments_causal_uniq
  ON finance.matriz_payroll_adjustments
    (environment,source_type,source_id,collaborator_id,original_payroll_item_id)
  WHERE source_type IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS matriz_payroll_adjustments_idempotency_uniq
  ON finance.matriz_payroll_adjustments (environment,idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS matriz_payroll_adjustments_review_idx
  ON finance.matriz_payroll_adjustments (environment,competence,created_at)
  WHERE causal_status='needs_review' AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS env_match_matriz_adjustment_original_item
  ON finance.matriz_payroll_adjustments;
CREATE TRIGGER env_match_matriz_adjustment_original_item
  BEFORE INSERT OR UPDATE OF original_payroll_item_id
  ON finance.matriz_payroll_adjustments FOR EACH ROW
  EXECUTE FUNCTION ops.validate_env_match('finance','matriz_payroll_items','original_payroll_item_id');

-- Uma folha fechada e um documento contabil: somente os campos de liquidacao
-- podem mudar. A despesa passa a ser criada antes do item, logo o vinculo ja
-- entra no INSERT e nao precisa de UPDATE economico posterior.
CREATE OR REPLACE FUNCTION finance.protect_matriz_payroll_item_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- Compatibilidade de rollout com o codigo 0142: ele cria o item e preenche o
  -- vinculo da despesa imediatamente depois, na mesma transacao. So essa
  -- transicao NULL -> UUID e aceita uma vez; o codigo 0143 ja insere vinculado.
  IF OLD.source_expense_id IS NULL AND NEW.source_expense_id IS NOT NULL
     AND NEW.environment IS NOT DISTINCT FROM OLD.environment
     AND NEW.payroll_period_id IS NOT DISTINCT FROM OLD.payroll_period_id
     AND NEW.collaborator_id IS NOT DISTINCT FROM OLD.collaborator_id
     AND NEW.job_title IS NOT DISTINCT FROM OLD.job_title
     AND NEW.employment_type IS NOT DISTINCT FROM OLD.employment_type
     AND NEW.base_salary IS NOT DISTINCT FROM OLD.base_salary
     AND NEW.commission_amount IS NOT DISTINCT FROM OLD.commission_amount
     AND NEW.additions IS NOT DISTINCT FROM OLD.additions
     AND NEW.deductions IS NOT DISTINCT FROM OLD.deductions
     AND NEW.total_due IS NOT DISTINCT FROM OLD.total_due
     AND NEW.due_date IS NOT DISTINCT FROM OLD.due_date
     AND NEW.calculation IS NOT DISTINCT FROM OLD.calculation
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  IF NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.payroll_period_id IS DISTINCT FROM OLD.payroll_period_id
     OR NEW.collaborator_id IS DISTINCT FROM OLD.collaborator_id
     OR NEW.job_title IS DISTINCT FROM OLD.job_title
     OR NEW.employment_type IS DISTINCT FROM OLD.employment_type
     OR NEW.base_salary IS DISTINCT FROM OLD.base_salary
     OR NEW.commission_amount IS DISTINCT FROM OLD.commission_amount
     OR NEW.additions IS DISTINCT FROM OLD.additions
     OR NEW.deductions IS DISTINCT FROM OLD.deductions
     OR NEW.total_due IS DISTINCT FROM OLD.total_due
     OR NEW.due_date IS DISTINCT FROM OLD.due_date
     OR NEW.source_expense_id IS DISTINCT FROM OLD.source_expense_id
     OR NEW.calculation IS DISTINCT FROM OLD.calculation
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payroll_snapshot_immutable';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS protect_matriz_payroll_item_snapshot
  ON finance.matriz_payroll_items;
CREATE TRIGGER protect_matriz_payroll_item_snapshot
  BEFORE UPDATE ON finance.matriz_payroll_items
  FOR EACH ROW EXECUTE FUNCTION finance.protect_matriz_payroll_item_snapshot();

-- Ajuste causal nao pode ser apagado nem reprecificado. A unica transicao
-- permitida e needs_review -> ready, com valor e ator owner registrados juntos.
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
     AND NEW.original_payroll_item_id IS NOT DISTINCT FROM OLD.original_payroll_item_id
     AND NEW.frozen_calculation IS NOT DISTINCT FROM OLD.frozen_calculation
     AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key THEN
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'causal_adjustment_immutable';
END
$fn$;

DROP TRIGGER IF EXISTS protect_matriz_causal_adjustment
  ON finance.matriz_payroll_adjustments;
CREATE TRIGGER protect_matriz_causal_adjustment
  BEFORE UPDATE OR DELETE ON finance.matriz_payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION finance.protect_matriz_causal_adjustment();

-- Estado financeiro derivado. O fuel_expense_id legado e deliberadamente
-- ignorado: somente comprovantes linked/legacy_linked com despesa viva valem.
CREATE OR REPLACE FUNCTION commerce.matriz_trip_financial_status(
  p_trip_id UUID,
  p_environment env_t
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce
AS $fn$
DECLARE
  v_status TEXT;
  v_fuel_spent NUMERIC;
  v_confirmed_amount NUMERIC;
  v_official_fuel NUMERIC;
  v_fuel_receipts INTEGER;
BEGIN
  SELECT t.status,COALESCE(t.fuel_spent,0),t.fuel_divergence_confirmed_amount
    INTO v_status,v_fuel_spent,v_confirmed_amount
    FROM commerce.matriz_delivery_trips t
   WHERE t.id=p_trip_id AND t.environment=p_environment AND t.deleted_at IS NULL;
  IF NOT FOUND OR v_status <> 'closed' THEN RETURN 'pending'; END IF;

  IF EXISTS (
    SELECT 1 FROM commerce.matriz_trip_receipts r
     WHERE r.trip_id=p_trip_id AND r.environment=p_environment
       AND r.workflow_status IN ('uploaded','processing','review_required')
  ) THEN RETURN 'pending'; END IF;

  IF EXISTS (
    SELECT 1 FROM commerce.matriz_trip_receipts r
     WHERE r.trip_id=p_trip_id AND r.environment=p_environment
       AND r.workflow_status IN ('linked','legacy_linked')
       AND (r.ai_expense_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM commerce.matriz_expenses e
          WHERE e.id=r.ai_expense_id AND e.environment=r.environment
            AND e.deleted_at IS NULL))
  ) THEN RETURN 'pending'; END IF;

  IF EXISTS (
    SELECT 1 FROM commerce.orders o
    JOIN commerce.order_items oi ON oi.order_id=o.id AND oi.environment=o.environment
     WHERE o.trip_id=p_trip_id AND o.environment=p_environment
       AND o.status<>'cancelled' AND o.delivery_status='delivered'
       AND oi.matriz_unit_cost IS NULL
  ) THEN RETURN 'pending'; END IF;

  SELECT count(*)::int,COALESCE(sum(x.amount),0)
    INTO v_fuel_receipts,v_official_fuel
    FROM (
      SELECT DISTINCT e.id,e.amount
        FROM commerce.matriz_trip_receipts r
        JOIN commerce.matriz_expenses e
          ON e.id=r.ai_expense_id AND e.environment=r.environment
         AND e.deleted_at IS NULL AND e.category='combustivel'
       WHERE r.trip_id=p_trip_id AND r.environment=p_environment
         AND r.workflow_status IN ('linked','legacy_linked')
    ) x;

  IF v_fuel_spent > 0 AND v_fuel_receipts=0 THEN RETURN 'pending'; END IF;
  IF v_fuel_receipts > 0
     AND v_official_fuel IS DISTINCT FROM v_fuel_spent
     AND v_confirmed_amount IS DISTINCT FROM v_official_fuel THEN
    RETURN 'divergent';
  END IF;
  RETURN 'reconciled';
END
$fn$;

REVOKE ALL ON FUNCTION commerce.matriz_trip_financial_status(UUID,env_t) FROM PUBLIC;

-- Calcula a primeira competencia nao fechada e segura o mesmo advisory lock
-- usado pelo fechamento da folha para eliminar a corrida ajuste x fechamento.
CREATE OR REPLACE FUNCTION finance.next_open_matriz_payroll_competence(
  p_environment env_t,
  p_start DATE
)
RETURNS DATE
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_competence DATE := date_trunc('month',p_start)::date;
BEGIN
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(
      'matriz-payroll:' || p_environment::text || ':' || v_competence::text));
    IF NOT EXISTS (
      SELECT 1 FROM finance.matriz_payroll_periods p
       WHERE p.environment=p_environment AND p.competence=v_competence
    ) THEN RETURN v_competence; END IF;
    v_competence := (v_competence + interval '1 month')::date;
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION finance.insert_matriz_causal_adjustment(
  p_environment env_t,
  p_collaborator_id UUID,
  p_source_type TEXT,
  p_source_id UUID,
  p_source_event_at TIMESTAMPTZ,
  p_original_item_id UUID,
  p_amount NUMERIC,
  p_calculation JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance, audit
AS $fn$
DECLARE
  v_id UUID;
  v_competence DATE;
  v_key TEXT;
  v_status TEXT;
BEGIN
  IF p_amount IS NOT NULL AND round(p_amount,2) <= 0 THEN RETURN NULL; END IF;
  v_competence := finance.next_open_matriz_payroll_competence(
    p_environment,(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date);
  v_key := 'payroll-causal:' || p_source_type || ':' || p_source_id::text
    || ':' || p_collaborator_id::text || ':' || p_original_item_id::text;
  v_status := CASE WHEN p_amount IS NULL THEN 'needs_review' ELSE 'ready' END;

  INSERT INTO finance.matriz_payroll_adjustments
    (environment,collaborator_id,competence,kind,description,amount,created_by,
     source_type,source_id,source_event_at,original_payroll_item_id,
     frozen_calculation,causal_status,idempotency_key)
  VALUES
    (p_environment,p_collaborator_id,v_competence,'deduction',
     CASE p_source_type
       WHEN 'delivery_cancellation' THEN 'Estorno causal: entrega cancelada apos folha'
       ELSE 'Estorno causal: venda cancelada apos folha' END,
     CASE WHEN p_amount IS NULL THEN NULL ELSE round(p_amount,2) END,
     'causal-trigger-0143',p_source_type,p_source_id,p_source_event_at,
     p_original_item_id,p_calculation,v_status,v_key)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO audit.events
      (environment,domain,entity_table,entity_id,event_type,actor_label,
       idempotency_key,payload_before,payload_after)
    VALUES
      (p_environment::text,'matriz_payroll','finance.matriz_payroll_adjustments',v_id,
       'causal_adjustment_created','causal-trigger-0143',v_key,NULL,
       jsonb_build_object('source_type',p_source_type,'source_id',p_source_id,
         'original_payroll_item_id',p_original_item_id,'competence',v_competence,
         'amount',p_amount,'causal_status',v_status));
  END IF;
  RETURN v_id;
END
$fn$;

-- Cancelamento posterior preserva o item fechado e enfileira a deducao na
-- primeira competencia aberta. Venda e entrega sao eventos independentes.
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

  IF OLD.seller_collaborator_id IS NOT NULL THEN
    v_event_date := (OLD.created_at AT TIME ZONE 'America/Sao_Paulo')::date;
    SELECT i.id INTO v_item_id
      FROM finance.matriz_payroll_items i
      JOIN finance.matriz_payroll_periods p ON p.id=i.payroll_period_id
     WHERE i.environment=OLD.environment
       AND i.collaborator_id=OLD.seller_collaborator_id
       AND p.competence=date_trunc('month',v_event_date)::date
       AND OLD.created_at<=p.closed_at;
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
         AND OLD.delivered_at<=p.closed_at;
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

DROP TRIGGER IF EXISTS queue_matriz_order_cancellation_adjustments ON commerce.orders;
CREATE TRIGGER queue_matriz_order_cancellation_adjustments
  AFTER UPDATE OF status ON commerce.orders
  FOR EACH ROW EXECUTE FUNCTION finance.queue_matriz_order_cancellation_adjustments();

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
  IF NEW.status <> 'cancelled' OR OLD.status='cancelled'
     OR OLD.seller_collaborator_id IS NULL THEN RETURN NEW; END IF;
  v_event_date := (OLD.created_at AT TIME ZONE 'America/Sao_Paulo')::date;
  SELECT i.id INTO v_item_id
    FROM finance.matriz_payroll_items i
    JOIN finance.matriz_payroll_periods p ON p.id=i.payroll_period_id
   WHERE i.environment=OLD.environment
     AND i.collaborator_id=OLD.seller_collaborator_id
     AND p.competence=date_trunc('month',v_event_date)::date
     AND OLD.created_at<=p.closed_at;
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

DROP TRIGGER IF EXISTS queue_matriz_wholesale_cancellation_adjustment
  ON commerce.wholesale_orders;
CREATE TRIGGER queue_matriz_wholesale_cancellation_adjustment
  AFTER UPDATE OF status ON commerce.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION finance.queue_matriz_wholesale_cancellation_adjustment();

REVOKE ALL ON FUNCTION finance.protect_matriz_payroll_item_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.protect_matriz_causal_adjustment() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.next_open_matriz_payroll_competence(env_t,DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.insert_matriz_causal_adjustment(
  env_t,UUID,TEXT,UUID,TIMESTAMPTZ,UUID,NUMERIC,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.queue_matriz_order_cancellation_adjustments() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.queue_matriz_wholesale_cancellation_adjustment() FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON commerce.matriz_delivery_trips FROM farejador_partner_app;
    REVOKE ALL ON finance.matriz_payroll_adjustments FROM farejador_partner_app;
    REVOKE ALL ON finance.matriz_payroll_items FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION commerce.matriz_trip_financial_status(UUID,env_t)
      FROM farejador_partner_app;
  END IF;
END
$security$;

-- Rollback (manual, somente com avaliacao de dados): remover triggers/functions,
-- indices/constraints/colunas novas. Nunca reescrever 0001-0142.
