-- 0154 - Continuidade mensal da Matriz e dos parceiros.
--
-- Objetivos:
--   1. fixar toda competencia financeira no calendario de America/Sao_Paulo;
--   2. congelar a comissao do funcionario quando a venda e realizada;
--   3. fechar meses anteriores de forma idempotente, gerando uma conta a pagar;
--   4. guardar o historico dos termos comerciais usados nas mensalidades da Rede;
--   5. permitir recuperacao automatica de meses que ficaram sem processamento.
--
-- A migration e aditiva. Nenhum fato financeiro existente e apagado.

-- ---------------------------------------------------------------------------
-- Competencia explicita nas despesas e contas do parceiro
-- ---------------------------------------------------------------------------

ALTER TABLE finance.partner_payables
  ADD COLUMN IF NOT EXISTS competence_month DATE;

UPDATE finance.partner_payables
   SET competence_month =
       date_trunc('month', created_at AT TIME ZONE 'America/Sao_Paulo')::date
 WHERE competence_month IS NULL;

ALTER TABLE finance.partner_payables
  ALTER COLUMN competence_month SET DEFAULT
    date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date,
  ALTER COLUMN competence_month SET NOT NULL;

ALTER TABLE finance.partner_payables
  DROP CONSTRAINT IF EXISTS partner_payables_competence_month_check;
ALTER TABLE finance.partner_payables
  ADD CONSTRAINT partner_payables_competence_month_check
  CHECK (competence_month=date_trunc('month',competence_month)::date);

CREATE INDEX IF NOT EXISTS partner_payables_unit_competence_idx
  ON finance.partner_payables(environment,unit_id,competence_month)
  WHERE deleted_at IS NULL;

ALTER TABLE finance.partner_expenses
  ADD COLUMN IF NOT EXISTS competence_month DATE;

UPDATE finance.partner_expenses
   SET competence_month=date_trunc('month',expense_date)::date
 WHERE competence_month IS NULL;

ALTER TABLE finance.partner_expenses
  ALTER COLUMN expense_date SET DEFAULT
    (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  ALTER COLUMN competence_month SET DEFAULT
    date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date,
  ALTER COLUMN competence_month SET NOT NULL;

ALTER TABLE finance.partner_expenses
  DROP CONSTRAINT IF EXISTS partner_expenses_competence_month_check;
ALTER TABLE finance.partner_expenses
  ADD CONSTRAINT partner_expenses_competence_month_check
  CHECK (competence_month=date_trunc('month',competence_month)::date);

CREATE INDEX IF NOT EXISTS partner_expenses_unit_competence_idx
  ON finance.partner_expenses(environment,unit_id,competence_month)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN finance.partner_payables.competence_month IS
  'Mes contabil da obrigacao no calendario America/Sao_Paulo; nao muda quando a conta e paga.';
COMMENT ON COLUMN finance.partner_expenses.competence_month IS
  'Mes contabil da despesa no calendario America/Sao_Paulo; separado da data da saida de caixa.';

-- ---------------------------------------------------------------------------
-- Historico temporal dos termos comerciais da Rede
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS network.partner_commercial_terms_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  partner_id UUID NOT NULL,
  commercial_model TEXT NOT NULL
    CHECK (commercial_model IN ('commission','monthly','hybrid')),
  commission_percent NUMERIC(5,2)
    CHECK (commission_percent IS NULL OR commission_percent>=0),
  monthly_fee NUMERIC(10,2)
    CHECK (monthly_fee IS NULL OR monthly_fee>=0),
  partner_status TEXT NOT NULL
    CHECK (partner_status IN ('credentialing','active','suspended')),
  partner_deleted BOOLEAN NOT NULL DEFAULT false,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  changed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_commercial_terms_history_partner_fk
    FOREIGN KEY (environment,partner_id)
    REFERENCES network.partners(environment,id),
  CHECK (valid_until IS NULL OR valid_until>=valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_commercial_terms_history_open_uniq
  ON network.partner_commercial_terms_history(environment,partner_id)
  WHERE valid_until IS NULL;

CREATE INDEX IF NOT EXISTS partner_commercial_terms_history_range_idx
  ON network.partner_commercial_terms_history(environment,partner_id,valid_from,valid_until);

DROP TRIGGER IF EXISTS env_match_partner_terms_history_partner
  ON network.partner_commercial_terms_history;
CREATE TRIGGER env_match_partner_terms_history_partner
  BEFORE INSERT OR UPDATE OF environment,partner_id
  ON network.partner_commercial_terms_history
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','partners','partner_id');

DROP TRIGGER IF EXISTS env_immutable_partner_terms_history
  ON network.partner_commercial_terms_history;
CREATE TRIGGER env_immutable_partner_terms_history
  BEFORE UPDATE OF environment ON network.partner_commercial_terms_history
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

INSERT INTO network.partner_commercial_terms_history
  (environment,partner_id,commercial_model,commission_percent,monthly_fee,
   partner_status,partner_deleted,valid_from,changed_by)
SELECT p.environment,p.id,p.commercial_model,p.commission_percent,p.monthly_fee,
       p.status,p.deleted_at IS NOT NULL,p.created_at,'migration:0154'
  FROM network.partners p
 WHERE NOT EXISTS (
   SELECT 1 FROM network.partner_commercial_terms_history h
    WHERE h.environment=p.environment AND h.partner_id=p.id
      AND h.valid_until IS NULL
 );

CREATE OR REPLACE FUNCTION network.capture_partner_commercial_terms_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE
  v_changed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO network.partner_commercial_terms_history
      (environment,partner_id,commercial_model,commission_percent,monthly_fee,
       partner_status,partner_deleted,valid_from,changed_by)
    VALUES
      (NEW.environment,NEW.id,NEW.commercial_model,NEW.commission_percent,
       NEW.monthly_fee,NEW.status,NEW.deleted_at IS NOT NULL,
       COALESCE(NEW.created_at,v_changed_at),'system:partner-created')
    ON CONFLICT DO NOTHING;
    RETURN NEW;
  END IF;

  IF ROW(NEW.commercial_model,NEW.commission_percent,NEW.monthly_fee,
         NEW.status,NEW.deleted_at)
     IS NOT DISTINCT FROM
     ROW(OLD.commercial_model,OLD.commission_percent,OLD.monthly_fee,
         OLD.status,OLD.deleted_at) THEN
    RETURN NEW;
  END IF;

  UPDATE network.partner_commercial_terms_history
     SET valid_until=v_changed_at
   WHERE environment=OLD.environment AND partner_id=OLD.id
     AND valid_until IS NULL;

  INSERT INTO network.partner_commercial_terms_history
    (environment,partner_id,commercial_model,commission_percent,monthly_fee,
     partner_status,partner_deleted,valid_from,changed_by)
  VALUES
    (NEW.environment,NEW.id,NEW.commercial_model,NEW.commission_percent,
     NEW.monthly_fee,NEW.status,NEW.deleted_at IS NOT NULL,v_changed_at,
     COALESCE(NULLIF(current_setting('app.actor_label',true),''),
              'system:partner-terms'));
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_commercial_terms_history_capture
  ON network.partners;
CREATE TRIGGER partner_commercial_terms_history_capture
AFTER INSERT OR UPDATE OF commercial_model,commission_percent,monthly_fee,status,deleted_at
ON network.partners
FOR EACH ROW EXECUTE FUNCTION network.capture_partner_commercial_terms_history();

REVOKE ALL ON network.partner_commercial_terms_history FROM PUBLIC;
REVOKE ALL ON FUNCTION network.capture_partner_commercial_terms_history() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Livro de comissao dos funcionarios do parceiro
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS finance.partner_staff_commission_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  partner_unit_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  token_id UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  competence_month DATE NOT NULL
    CHECK (competence_month=date_trunc('month',competence_month)::date),
  sales_count INTEGER NOT NULL CHECK (sales_count>=0),
  gross_sales NUMERIC(14,2) NOT NULL CHECK (gross_sales>=0),
  earned_amount NUMERIC(14,2) NOT NULL CHECK (earned_amount>=0),
  adjustment_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  payable_amount NUMERIC(14,2) NOT NULL CHECK (payable_amount>=0),
  payable_id UUID REFERENCES finance.partner_payables(id),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by TEXT NOT NULL DEFAULT 'system:monthly-rollover',
  CONSTRAINT partner_staff_commission_periods_unit_fk
    FOREIGN KEY (environment,partner_unit_id)
    REFERENCES network.partner_units(environment,id),
  CONSTRAINT partner_staff_commission_periods_core_unit_fk
    FOREIGN KEY (environment,unit_id)
    REFERENCES core.units(environment,id),
  CONSTRAINT partner_staff_commission_periods_uniq
    UNIQUE (environment,token_id,competence_month),
  CHECK ((payable_amount=0 AND payable_id IS NULL)
      OR (payable_amount>0 AND payable_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS finance.partner_staff_commission_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  partner_unit_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  token_id UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  partner_order_id UUID NOT NULL,
  competence_month DATE NOT NULL
    CHECK (competence_month=date_trunc('month',competence_month)::date),
  gross_amount NUMERIC(14,2) NOT NULL CHECK (gross_amount>=0),
  commission_kind TEXT NOT NULL CHECK (commission_kind IN ('percent','fixed')),
  commission_value NUMERIC(12,2) NOT NULL CHECK (commission_value>=0),
  commission_amount NUMERIC(14,2) NOT NULL CHECK (commission_amount>=0),
  realized_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'earned' CHECK (status IN ('earned','reversed')),
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  settlement_period_id UUID
    REFERENCES finance.partner_staff_commission_periods(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_staff_commission_entries_order_fk
    FOREIGN KEY (environment,partner_order_id)
    REFERENCES commerce.partner_orders(environment,id),
  CONSTRAINT partner_staff_commission_entries_unit_fk
    FOREIGN KEY (environment,partner_unit_id)
    REFERENCES network.partner_units(environment,id),
  CONSTRAINT partner_staff_commission_entries_core_unit_fk
    FOREIGN KEY (environment,unit_id)
    REFERENCES core.units(environment,id),
  CONSTRAINT partner_staff_commission_entries_order_uniq
    UNIQUE (environment,partner_order_id),
  CHECK ((status='earned' AND reversed_at IS NULL)
      OR (status='reversed' AND reversed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS finance.partner_staff_commission_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  partner_unit_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  token_id UUID NOT NULL REFERENCES network.partner_access_tokens(id),
  commission_entry_id UUID NOT NULL
    REFERENCES finance.partner_staff_commission_entries(id),
  competence_month DATE NOT NULL
    CHECK (competence_month=date_trunc('month',competence_month)::date),
  amount NUMERIC(14,2) NOT NULL CHECK (amount<0),
  reason TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settlement_period_id UUID
    REFERENCES finance.partner_staff_commission_periods(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_staff_commission_adjustments_unit_fk
    FOREIGN KEY (environment,partner_unit_id)
    REFERENCES network.partner_units(environment,id),
  CONSTRAINT partner_staff_commission_adjustments_core_unit_fk
    FOREIGN KEY (environment,unit_id)
    REFERENCES core.units(environment,id),
  CONSTRAINT partner_staff_commission_adjustments_reversal_uniq
    UNIQUE (environment,commission_entry_id)
);

CREATE INDEX IF NOT EXISTS partner_staff_commission_entries_close_idx
  ON finance.partner_staff_commission_entries
    (environment,token_id,competence_month)
  WHERE status='earned' AND settlement_period_id IS NULL;

CREATE INDEX IF NOT EXISTS partner_staff_commission_adjustments_close_idx
  ON finance.partner_staff_commission_adjustments
    (environment,token_id,competence_month)
  WHERE settlement_period_id IS NULL;

CREATE INDEX IF NOT EXISTS partner_staff_commission_periods_unit_idx
  ON finance.partner_staff_commission_periods
    (environment,unit_id,competence_month DESC);

-- UUID global nao basta para separar prod/test: toda referencia nova valida
-- explicitamente que a linha apontada pertence ao mesmo environment.
DROP TRIGGER IF EXISTS env_match_staff_period_partner_unit
  ON finance.partner_staff_commission_periods;
CREATE TRIGGER env_match_staff_period_partner_unit
  BEFORE INSERT OR UPDATE OF environment,partner_unit_id
  ON finance.partner_staff_commission_periods
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','partner_units','partner_unit_id');

DROP TRIGGER IF EXISTS env_match_staff_period_unit
  ON finance.partner_staff_commission_periods;
CREATE TRIGGER env_match_staff_period_unit
  BEFORE INSERT OR UPDATE OF environment,unit_id
  ON finance.partner_staff_commission_periods
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'core','units','unit_id');

DROP TRIGGER IF EXISTS env_match_staff_period_token
  ON finance.partner_staff_commission_periods;
CREATE TRIGGER env_match_staff_period_token
  BEFORE INSERT OR UPDATE OF environment,token_id
  ON finance.partner_staff_commission_periods
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','partner_access_tokens','token_id');

DROP TRIGGER IF EXISTS env_match_staff_period_payable
  ON finance.partner_staff_commission_periods;
CREATE TRIGGER env_match_staff_period_payable
  BEFORE INSERT OR UPDATE OF environment,payable_id
  ON finance.partner_staff_commission_periods
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','partner_payables','payable_id');

DROP TRIGGER IF EXISTS env_match_staff_entry_partner_unit
  ON finance.partner_staff_commission_entries;
CREATE TRIGGER env_match_staff_entry_partner_unit
  BEFORE INSERT OR UPDATE OF environment,partner_unit_id
  ON finance.partner_staff_commission_entries
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','partner_units','partner_unit_id');

DROP TRIGGER IF EXISTS env_match_staff_entry_unit
  ON finance.partner_staff_commission_entries;
CREATE TRIGGER env_match_staff_entry_unit
  BEFORE INSERT OR UPDATE OF environment,unit_id
  ON finance.partner_staff_commission_entries
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'core','units','unit_id');

DROP TRIGGER IF EXISTS env_match_staff_entry_token
  ON finance.partner_staff_commission_entries;
CREATE TRIGGER env_match_staff_entry_token
  BEFORE INSERT OR UPDATE OF environment,token_id
  ON finance.partner_staff_commission_entries
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','partner_access_tokens','token_id');

DROP TRIGGER IF EXISTS env_match_staff_entry_order
  ON finance.partner_staff_commission_entries;
CREATE TRIGGER env_match_staff_entry_order
  BEFORE INSERT OR UPDATE OF environment,partner_order_id
  ON finance.partner_staff_commission_entries
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'commerce','partner_orders','partner_order_id');

DROP TRIGGER IF EXISTS env_match_staff_entry_period
  ON finance.partner_staff_commission_entries;
CREATE TRIGGER env_match_staff_entry_period
  BEFORE INSERT OR UPDATE OF environment,settlement_period_id
  ON finance.partner_staff_commission_entries
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','partner_staff_commission_periods','settlement_period_id');

DROP TRIGGER IF EXISTS env_match_staff_adjustment_partner_unit
  ON finance.partner_staff_commission_adjustments;
CREATE TRIGGER env_match_staff_adjustment_partner_unit
  BEFORE INSERT OR UPDATE OF environment,partner_unit_id
  ON finance.partner_staff_commission_adjustments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','partner_units','partner_unit_id');

DROP TRIGGER IF EXISTS env_match_staff_adjustment_unit
  ON finance.partner_staff_commission_adjustments;
CREATE TRIGGER env_match_staff_adjustment_unit
  BEFORE INSERT OR UPDATE OF environment,unit_id
  ON finance.partner_staff_commission_adjustments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'core','units','unit_id');

DROP TRIGGER IF EXISTS env_match_staff_adjustment_token
  ON finance.partner_staff_commission_adjustments;
CREATE TRIGGER env_match_staff_adjustment_token
  BEFORE INSERT OR UPDATE OF environment,token_id
  ON finance.partner_staff_commission_adjustments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','partner_access_tokens','token_id');

DROP TRIGGER IF EXISTS env_match_staff_adjustment_entry
  ON finance.partner_staff_commission_adjustments;
CREATE TRIGGER env_match_staff_adjustment_entry
  BEFORE INSERT OR UPDATE OF environment,commission_entry_id
  ON finance.partner_staff_commission_adjustments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','partner_staff_commission_entries','commission_entry_id');

DROP TRIGGER IF EXISTS env_match_staff_adjustment_period
  ON finance.partner_staff_commission_adjustments;
CREATE TRIGGER env_match_staff_adjustment_period
  BEFORE INSERT OR UPDATE OF environment,settlement_period_id
  ON finance.partner_staff_commission_adjustments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','partner_staff_commission_periods','settlement_period_id');

CREATE OR REPLACE FUNCTION finance.guard_partner_staff_commission_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'partner_staff_commission_fact_immutable';
  END IF;
  IF ROW(NEW.environment,NEW.partner_unit_id,NEW.unit_id,NEW.token_id,
         NEW.partner_order_id,NEW.competence_month,NEW.gross_amount,
         NEW.commission_kind,NEW.commission_value,NEW.commission_amount,
         NEW.realized_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.environment,OLD.partner_unit_id,OLD.unit_id,OLD.token_id,
         OLD.partner_order_id,OLD.competence_month,OLD.gross_amount,
         OLD.commission_kind,OLD.commission_value,OLD.commission_amount,
         OLD.realized_at,OLD.created_at) THEN
    RAISE EXCEPTION 'partner_staff_commission_fact_immutable';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_staff_commission_entries_immutable
  ON finance.partner_staff_commission_entries;
CREATE TRIGGER partner_staff_commission_entries_immutable
BEFORE UPDATE OR DELETE ON finance.partner_staff_commission_entries
FOR EACH ROW EXECUTE FUNCTION finance.guard_partner_staff_commission_fact();

CREATE OR REPLACE FUNCTION finance.guard_partner_staff_adjustment_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' OR
     ROW(NEW.environment,NEW.partner_unit_id,NEW.unit_id,NEW.token_id,
         NEW.commission_entry_id,NEW.competence_month,NEW.amount,
         NEW.reason,NEW.occurred_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.environment,OLD.partner_unit_id,OLD.unit_id,OLD.token_id,
         OLD.commission_entry_id,OLD.competence_month,OLD.amount,
         OLD.reason,OLD.occurred_at,OLD.created_at) THEN
    RAISE EXCEPTION 'partner_staff_commission_adjustment_immutable';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_staff_commission_adjustments_immutable
  ON finance.partner_staff_commission_adjustments;
CREATE TRIGGER partner_staff_commission_adjustments_immutable
BEFORE UPDATE OR DELETE ON finance.partner_staff_commission_adjustments
FOR EACH ROW EXECUTE FUNCTION finance.guard_partner_staff_adjustment_fact();

CREATE OR REPLACE FUNCTION finance.guard_partner_staff_period()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'partner_staff_commission_period_immutable';
END;
$function$;

DROP TRIGGER IF EXISTS partner_staff_commission_periods_immutable
  ON finance.partner_staff_commission_periods;
CREATE TRIGGER partner_staff_commission_periods_immutable
BEFORE UPDATE OR DELETE ON finance.partner_staff_commission_periods
FOR EACH ROW EXECUTE FUNCTION finance.guard_partner_staff_period();

-- Uma conta de comissao fechada pode ser paga, mas nao cancelada ou reescrita.
CREATE OR REPLACE FUNCTION finance.guard_partner_staff_commission_payable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finance.partner_staff_commission_periods p
     WHERE p.payable_id=OLD.id
  ) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'partner_staff_commission_payable_immutable';
  END IF;
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

DROP TRIGGER IF EXISTS partner_staff_commission_payable_immutable
  ON finance.partner_payables;
CREATE TRIGGER partner_staff_commission_payable_immutable
BEFORE UPDATE OR DELETE ON finance.partner_payables
FOR EACH ROW EXECUTE FUNCTION finance.guard_partner_staff_commission_payable();

CREATE OR REPLACE FUNCTION finance.record_partner_staff_commission_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE
  v_realized BOOLEAN;
  v_was_realized BOOLEAN := false;
  v_realized_at TIMESTAMPTZ;
  v_rule RECORD;
  v_entry RECORD;
BEGIN
  v_realized := NEW.status<>'cancelled' AND NEW.deleted_at IS NULL
    AND NOT (NEW.fulfillment_mode='delivery' AND NEW.delivery_status<>'delivered')
    AND NOT NEW.awaiting_pickup;
  IF TG_OP='UPDATE' THEN
    v_was_realized := OLD.status<>'cancelled' AND OLD.deleted_at IS NULL
      AND NOT (OLD.fulfillment_mode='delivery' AND OLD.delivery_status<>'delivered')
      AND NOT OLD.awaiting_pickup;
  END IF;

  IF v_realized AND (TG_OP='INSERT' OR NOT v_was_realized
      OR OLD.operator_token_id IS DISTINCT FROM NEW.operator_token_id)
     AND NEW.operator_token_id IS NOT NULL THEN
    v_realized_at := CASE WHEN NEW.fulfillment_mode='delivery'
      THEN COALESCE(NEW.delivered_at,clock_timestamp())
      ELSE COALESCE(NEW.retrieved_at,NEW.created_at,clock_timestamp()) END;

    SELECT pat.partner_unit_id,cc.kind,cc.value
      INTO v_rule
      FROM network.partner_access_tokens pat
      JOIN network.partner_token_commission cc
        ON cc.token_id=pat.id AND cc.environment=pat.environment
     WHERE pat.id=NEW.operator_token_id
       AND pat.environment=NEW.environment
       AND pat.role='funcionario'
       AND cc.active AND cc.value>0
     LIMIT 1;

    IF v_rule.partner_unit_id IS NOT NULL THEN
      INSERT INTO finance.partner_staff_commission_entries
        (environment,partner_unit_id,unit_id,token_id,partner_order_id,
         competence_month,gross_amount,commission_kind,commission_value,
         commission_amount,realized_at)
      VALUES
        (NEW.environment,v_rule.partner_unit_id,NEW.unit_id,NEW.operator_token_id,
         NEW.id,date_trunc('month',v_realized_at AT TIME ZONE
           'America/Sao_Paulo')::date,
         COALESCE(NEW.total_amount,0),v_rule.kind,v_rule.value,
         CASE WHEN v_rule.kind='percent'
           THEN round(COALESCE(NEW.total_amount,0)*v_rule.value/100.0,2)
           ELSE v_rule.value END,
         v_realized_at)
      ON CONFLICT (environment,partner_order_id) DO NOTHING;
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND v_was_realized AND NOT v_realized THEN
    SELECT * INTO v_entry
      FROM finance.partner_staff_commission_entries
     WHERE environment=NEW.environment AND partner_order_id=NEW.id
       AND status='earned'
     FOR UPDATE;
    IF v_entry.id IS NOT NULL THEN
      IF v_entry.settlement_period_id IS NOT NULL
         AND v_entry.commission_amount>0 THEN
        INSERT INTO finance.partner_staff_commission_adjustments
          (environment,partner_unit_id,unit_id,token_id,commission_entry_id,
           competence_month,amount,reason,occurred_at)
        VALUES
          (v_entry.environment,v_entry.partner_unit_id,v_entry.unit_id,
           v_entry.token_id,v_entry.id,
           date_trunc('month',clock_timestamp() AT TIME ZONE
             'America/Sao_Paulo')::date,
           -v_entry.commission_amount,'venda cancelada apos fechamento',
           clock_timestamp())
        ON CONFLICT (environment,commission_entry_id) DO NOTHING;
      END IF;
      UPDATE finance.partner_staff_commission_entries
         SET status='reversed',reversed_at=clock_timestamp(),
             reversal_reason='venda cancelada/desfeita'
       WHERE id=v_entry.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_order_staff_commission_transition
  ON commerce.partner_orders;
CREATE TRIGGER partner_order_staff_commission_transition
AFTER INSERT OR UPDATE OF operator_token_id,status,delivery_status,delivered_at,
  awaiting_pickup,retrieved_at,deleted_at
ON commerce.partner_orders
FOR EACH ROW EXECUTE FUNCTION finance.record_partner_staff_commission_transition();

-- Backfill seguro: so usa uma regra que ja existia quando a venda foi realizada.
WITH realized AS (
  SELECT po.*,
         CASE WHEN po.fulfillment_mode='delivery'
              THEN po.delivered_at
              ELSE COALESCE(po.retrieved_at,po.created_at) END AS realized_at
    FROM commerce.partner_orders po
   WHERE po.operator_token_id IS NOT NULL
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
       CASE WHEN cc.kind='percent'
         THEN round(COALESCE(r.total_amount,0)*cc.value/100.0,2)
         ELSE cc.value END,
       r.realized_at
  FROM realized r
  JOIN network.partner_access_tokens pat
    ON pat.id=r.operator_token_id AND pat.environment=r.environment
   AND pat.role='funcionario'
  JOIN network.partner_token_commission cc
    ON cc.token_id=pat.id AND cc.environment=pat.environment
   AND cc.active AND cc.value>0 AND cc.updated_at<=r.realized_at
ON CONFLICT (environment,partner_order_id) DO NOTHING;

-- Fecha todas as competencias anteriores ao mes corrente. A funcao pode rodar
-- varias vezes e em varias instancias: advisory lock + chaves unicas impedem dupla conta.
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
  v_current_month DATE :=
    date_trunc('month',p_now AT TIME ZONE 'America/Sao_Paulo')::date;
  v_bucket RECORD;
  v_totals RECORD;
  v_counterparty TEXT;
  v_payable_id UUID;
  v_period_id UUID;
  v_closed INTEGER := 0;
  v_payables INTEGER := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('partner-staff-commission:'||p_environment::text)
  );

  -- Repara transicoes eventualmente perdidas, sem aplicar regra criada depois da venda.
  WITH realized AS (
    SELECT po.*,
           CASE WHEN po.fulfillment_mode='delivery'
                THEN po.delivered_at
                ELSE COALESCE(po.retrieved_at,po.created_at) END AS realized_at
      FROM commerce.partner_orders po
     WHERE po.environment=p_environment
       AND po.operator_token_id IS NOT NULL
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
         CASE WHEN cc.kind='percent'
           THEN round(COALESCE(r.total_amount,0)*cc.value/100.0,2)
           ELSE cc.value END,
         r.realized_at
    FROM realized r
    JOIN network.partner_access_tokens pat
      ON pat.id=r.operator_token_id AND pat.environment=r.environment
     AND pat.role='funcionario'
    JOIN network.partner_token_commission cc
      ON cc.token_id=pat.id AND cc.environment=pat.environment
     AND cc.active AND cc.value>0 AND cc.updated_at<=r.realized_at
  ON CONFLICT (environment,partner_order_id) DO NOTHING;

  INSERT INTO finance.partner_staff_commission_adjustments
    (environment,partner_unit_id,unit_id,token_id,commission_entry_id,
     competence_month,amount,reason,occurred_at)
  SELECT ce.environment,ce.partner_unit_id,ce.unit_id,ce.token_id,ce.id,
         date_trunc('month',p_now AT TIME ZONE 'America/Sao_Paulo')::date,
         -ce.commission_amount,'venda cancelada apos fechamento',p_now
    FROM finance.partner_staff_commission_entries ce
    JOIN commerce.partner_orders po
      ON po.environment=ce.environment AND po.id=ce.partner_order_id
   WHERE ce.environment=p_environment AND ce.status='earned'
     AND ce.settlement_period_id IS NOT NULL
     AND (po.status='cancelled' OR po.deleted_at IS NOT NULL
       OR (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
       OR po.awaiting_pickup)
  ON CONFLICT (environment,commission_entry_id) DO NOTHING;

  UPDATE finance.partner_staff_commission_entries ce
     SET status='reversed',reversed_at=p_now,
         reversal_reason='venda cancelada/desfeita'
    FROM commerce.partner_orders po
   WHERE ce.environment=p_environment
     AND po.environment=ce.environment AND po.id=ce.partner_order_id
     AND ce.status='earned'
     AND (po.status='cancelled' OR po.deleted_at IS NOT NULL
       OR (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
       OR po.awaiting_pickup);

  FOR v_bucket IN
    SELECT q.token_id,q.partner_unit_id,q.unit_id,q.competence_month
      FROM (
        SELECT token_id,partner_unit_id,unit_id,competence_month
          FROM finance.partner_staff_commission_entries
         WHERE environment=p_environment AND status='earned'
           AND settlement_period_id IS NULL
           AND competence_month<v_current_month
        UNION
        SELECT token_id,partner_unit_id,unit_id,competence_month
          FROM finance.partner_staff_commission_adjustments
         WHERE environment=p_environment AND settlement_period_id IS NULL
           AND competence_month<v_current_month
      ) q
     ORDER BY q.competence_month,q.token_id
  LOOP
    SELECT
      count(*)::int AS sales_count,
      COALESCE(sum(gross_amount),0)::numeric(14,2) AS gross_sales,
      COALESCE(sum(commission_amount),0)::numeric(14,2) AS earned_amount,
      COALESCE((
        SELECT sum(a.amount)
          FROM finance.partner_staff_commission_adjustments a
         WHERE a.environment=p_environment
           AND a.token_id=v_bucket.token_id
           AND a.settlement_period_id IS NULL
           AND a.competence_month<=v_bucket.competence_month
      ),0)::numeric(14,2) AS adjustment_amount
      INTO v_totals
      FROM finance.partner_staff_commission_entries e
     WHERE e.environment=p_environment
       AND e.token_id=v_bucket.token_id
       AND e.status='earned'
       AND e.settlement_period_id IS NULL
       AND e.competence_month<=v_bucket.competence_month;

    IF round(v_totals.earned_amount+v_totals.adjustment_amount,2)<0 THEN
      CONTINUE;
    END IF;

    v_payable_id := NULL;
    IF round(v_totals.earned_amount+v_totals.adjustment_amount,2)>0 THEN
      SELECT COALESCE(NULLIF(btrim(pat.label),''),
                      NULLIF(btrim(pat.login_username),''),
                      'Funcionario')
        INTO v_counterparty
        FROM network.partner_access_tokens pat
       WHERE pat.id=v_bucket.token_id AND pat.environment=p_environment;

      INSERT INTO finance.partner_payables
        (environment,unit_id,counterparty_name,description,category,amount,
         due_date,status,notes,idempotency_key,created_by,competence_month)
      VALUES
        (p_environment,v_bucket.unit_id,v_counterparty,
         'Comissao da equipe - '||
           to_char(v_bucket.competence_month,'MM/YYYY'),
         'employee',round(v_totals.earned_amount+v_totals.adjustment_amount,2),
         (v_bucket.competence_month+interval '1 month 4 days')::date,
         'open','Fechamento automatico e imutavel por competencia.',
         'staff-commission:'||v_bucket.token_id::text||':'||
           to_char(v_bucket.competence_month,'YYYY-MM'),
         'system:monthly-rollover',v_bucket.competence_month)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
      DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
      RETURNING id INTO v_payable_id;
      v_payables := v_payables+1;
    END IF;

    INSERT INTO finance.partner_staff_commission_periods
      (environment,partner_unit_id,unit_id,token_id,competence_month,
       sales_count,gross_sales,earned_amount,adjustment_amount,payable_amount,
       payable_id,closed_at)
    VALUES
      (p_environment,v_bucket.partner_unit_id,v_bucket.unit_id,v_bucket.token_id,
       v_bucket.competence_month,v_totals.sales_count,v_totals.gross_sales,
       v_totals.earned_amount,v_totals.adjustment_amount,
       round(v_totals.earned_amount+v_totals.adjustment_amount,2),
       v_payable_id,p_now)
    ON CONFLICT (environment,token_id,competence_month) DO NOTHING
    RETURNING id INTO v_period_id;

    IF v_period_id IS NULL THEN
      RAISE EXCEPTION 'partner_staff_commission_period_conflict';
    END IF;

    UPDATE finance.partner_staff_commission_entries
       SET settlement_period_id=v_period_id
     WHERE environment=p_environment AND token_id=v_bucket.token_id
       AND status='earned' AND settlement_period_id IS NULL
       AND competence_month<=v_bucket.competence_month;

    UPDATE finance.partner_staff_commission_adjustments
       SET settlement_period_id=v_period_id
     WHERE environment=p_environment AND token_id=v_bucket.token_id
       AND settlement_period_id IS NULL
       AND competence_month<=v_bucket.competence_month;

    v_closed := v_closed+1;
    v_period_id := NULL;
  END LOOP;

  RETURN jsonb_build_object(
    'environment',p_environment,
    'current_month',v_current_month,
    'periods_closed',v_closed,
    'payables_created',v_payables
  );
END;
$function$;

-- Isolamento da leitura pelas views security_invoker do portal.
ALTER TABLE finance.partner_staff_commission_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.partner_staff_commission_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.partner_staff_commission_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_staff_commission_periods_isolation
  ON finance.partner_staff_commission_periods;
CREATE POLICY partner_staff_commission_periods_isolation
  ON finance.partner_staff_commission_periods FOR SELECT
  USING (unit_id=network.current_partner_core_unit());

DROP POLICY IF EXISTS partner_staff_commission_entries_isolation
  ON finance.partner_staff_commission_entries;
CREATE POLICY partner_staff_commission_entries_isolation
  ON finance.partner_staff_commission_entries FOR SELECT
  USING (unit_id=network.current_partner_core_unit());

DROP POLICY IF EXISTS partner_staff_commission_adjustments_isolation
  ON finance.partner_staff_commission_adjustments;
CREATE POLICY partner_staff_commission_adjustments_isolation
  ON finance.partner_staff_commission_adjustments FOR SELECT
  USING (unit_id=network.current_partner_core_unit());

REVOKE ALL ON finance.partner_staff_commission_periods FROM PUBLIC;
REVOKE ALL ON finance.partner_staff_commission_entries FROM PUBLIC;
REVOKE ALL ON finance.partner_staff_commission_adjustments FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.run_partner_staff_commission_rollover(env_t,timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.record_partner_staff_commission_transition()
  FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    GRANT SELECT ON finance.partner_staff_commission_periods
      TO farejador_partner_app;
    GRANT SELECT ON finance.partner_staff_commission_entries
      TO farejador_partner_app;
    GRANT SELECT ON finance.partner_staff_commission_adjustments
      TO farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.run_partner_staff_commission_rollover(env_t,timestamptz)
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.record_partner_staff_commission_transition()
      FROM farejador_partner_app;
  END IF;
END;
$grants$;

COMMENT ON TABLE finance.partner_staff_commission_entries IS
  'Comissao congelada no instante em que o funcionario realiza a venda; regra e valor nao mudam retroativamente.';
COMMENT ON TABLE finance.partner_staff_commission_periods IS
  'Fechamento mensal idempotente da folha variavel; no maximo uma conta a pagar por funcionario e competencia.';
COMMENT ON TABLE finance.partner_staff_commission_adjustments IS
  'Credito negativo carregado para o fechamento seguinte quando uma venda ja fechada e cancelada.';

-- ---------------------------------------------------------------------------
-- Resumo do parceiro: competencia contabil, caixa separado e comissao corrente
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW network.partner_unit_summary
WITH (security_invoker = true) AS
WITH month_bounds AS (
  SELECT
    (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')
      AT TIME ZONE 'America/Sao_Paulo') AS month_start_at,
    date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date AS month_start_date
)
SELECT
  pu.environment,
  pu.id AS partner_unit_id,
  pu.unit_id,
  pu.slug,
  pu.display_name,
  p.id AS partner_id,
  p.trade_name AS partner_name,
  p.status AS partner_status,
  pu.status AS unit_status,
  COALESCE(orders_month.total_sales,0::numeric) AS sales_month,
  COALESCE(orders_month.order_count,0) AS orders_month,
  COALESCE(purchases_month.total_purchases,0::numeric) AS purchases_month,
  COALESCE(expenses_month.total_expenses,0::numeric) AS expenses_month,
  CASE WHEN COALESCE(cogs_month.pending_count,0)=0
    THEN COALESCE(orders_month.total_sales,0::numeric)
      - COALESCE(cogs_month.known_total,0::numeric)
      - COALESCE(expenses_month.total_expenses,0::numeric)
    ELSE NULL::numeric END AS result_competencia_month,
  CASE WHEN COALESCE(cogs_month.pending_count,0)=0
    THEN COALESCE(orders_month.total_sales,0::numeric)
      - COALESCE(cogs_month.known_total,0::numeric)
      - COALESCE(expenses_month.total_expenses,0::numeric)
    ELSE NULL::numeric END AS estimated_result_month,
  COALESCE(cash_in_month.total,0::numeric) AS cash_in_month,
  COALESCE(cash_out_month.total,0::numeric) AS cash_out_month,
  COALESCE(cash_in_month.total,0::numeric)
    - COALESCE(cash_out_month.total,0::numeric) AS cash_net_month,
  COALESCE(open_recv.total,0::numeric) AS open_receivables_total,
  COALESCE(open_pay.total,0::numeric) AS open_payables_total,
  COALESCE(open_recv.total,0::numeric)
    - COALESCE(open_pay.total,0::numeric) AS net_future_position,
  COALESCE(stock_counts.stock_items,0) AS stock_items,
  COALESCE(stock_counts.low_stock_items,0) AS low_stock_items,
  COALESCE(cogs_month.known_total,0::numeric) AS cogs_month,
  COALESCE(cogs_month.known_total,0::numeric) AS known_cogs_month,
  COALESCE(cogs_month.pending_count,0) AS pending_cost_items_month,
  COALESCE(cogs_month.pending_revenue,0::numeric) AS pending_cost_revenue_month,
  COALESCE(cogs_month.pending_count,0)>0 AS has_pending_cost_month,
  CASE WHEN COALESCE(cogs_month.pending_count,0)=0
    THEN COALESCE(orders_month.total_sales,0::numeric)
      - COALESCE(cogs_month.known_total,0::numeric)
      - COALESCE(expenses_month.total_expenses,0::numeric)
    ELSE NULL::numeric END AS confirmed_result_month
FROM network.partner_units pu
JOIN network.partners p
  ON p.id=pu.partner_id AND p.environment=pu.environment
CROSS JOIN month_bounds mb
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS order_count,
         COALESCE(sum(po.total_amount),0::numeric) AS total_sales
    FROM commerce.partner_orders po
   WHERE po.environment=pu.environment AND po.unit_id=pu.unit_id
     AND po.status<>'cancelled' AND po.deleted_at IS NULL
     AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
     AND NOT po.awaiting_pickup
     AND (CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
               ELSE COALESCE(po.retrieved_at,po.created_at) END)>=mb.month_start_at
) orders_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE(sum(oi.quantity::numeric*oi.unit_cost_snapshot)
      FILTER (WHERE oi.cost_status='known'),0::numeric) AS known_total,
    count(*) FILTER (WHERE oi.cost_status='pending')::integer AS pending_count,
    COALESCE(sum(oi.quantity::numeric*oi.unit_price-oi.discount_amount)
      FILTER (WHERE oi.cost_status='pending'),0::numeric) AS pending_revenue
    FROM commerce.partner_orders po_c
    JOIN commerce.partner_order_items oi
      ON oi.order_id=po_c.id AND oi.environment=po_c.environment
   WHERE po_c.environment=pu.environment AND po_c.unit_id=pu.unit_id
     AND po_c.status<>'cancelled' AND po_c.deleted_at IS NULL
     AND NOT (po_c.fulfillment_mode='delivery'
       AND po_c.delivery_status<>'delivered')
     AND NOT po_c.awaiting_pickup
     AND (CASE WHEN po_c.fulfillment_mode='delivery' THEN po_c.delivered_at
               ELSE COALESCE(po_c.retrieved_at,po_c.created_at) END)>=mb.month_start_at
) cogs_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(pp.total_amount),0::numeric) AS total_purchases
    FROM commerce.partner_purchases pp
   WHERE pp.environment=pu.environment AND pp.unit_id=pu.unit_id
     AND pp.purchased_at>=mb.month_start_at AND pp.deleted_at IS NULL
) purchases_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE((SELECT sum(pe.amount) FROM finance.partner_expenses pe
      WHERE pe.environment=pu.environment AND pe.unit_id=pu.unit_id
        AND pe.deleted_at IS NULL AND pe.source_payable_id IS NULL
        AND pe.competence_month=mb.month_start_date),0::numeric)
    + COALESCE((SELECT sum(pp.amount) FROM finance.partner_payables pp
      WHERE pp.environment=pu.environment AND pp.unit_id=pu.unit_id
        AND pp.deleted_at IS NULL AND pp.source_purchase_id IS NULL
        AND pp.status IN ('open','paid')
        AND pp.competence_month=mb.month_start_date),0::numeric)
    + COALESCE((SELECT sum(ce.commission_amount)
      FROM finance.partner_staff_commission_entries ce
      WHERE ce.environment=pu.environment AND ce.unit_id=pu.unit_id
        AND ce.status='earned' AND ce.settlement_period_id IS NULL
        AND ce.competence_month=mb.month_start_date),0::numeric)
    + COALESCE((SELECT sum(ca.amount)
      FROM finance.partner_staff_commission_adjustments ca
      WHERE ca.environment=pu.environment AND ca.unit_id=pu.unit_id
        AND ca.settlement_period_id IS NULL
        AND ca.competence_month=mb.month_start_date),0::numeric)
      AS total_expenses
) expenses_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE((SELECT sum(po.total_amount) FROM commerce.partner_orders po
      WHERE po.environment=pu.environment AND po.unit_id=pu.unit_id
        AND po.status<>'cancelled' AND po.deleted_at IS NULL
        AND po.created_at>=mb.month_start_at
        AND (po.payment_method IS NULL OR po.payment_method<>'A receber')),0::numeric)
    + COALESCE((SELECT sum(pre.amount)
      FROM finance.partner_receivables_effective pre
      WHERE pre.environment=pu.environment AND pre.unit_id=pu.unit_id
        AND pre.status='received' AND pre.received_at>=mb.month_start_at),0::numeric)
      AS total
) cash_in_month ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE((SELECT sum(pp.total_amount) FROM commerce.partner_purchases pp
      WHERE pp.environment=pu.environment AND pp.unit_id=pu.unit_id
        AND pp.deleted_at IS NULL AND pp.purchased_at>=mb.month_start_at
        AND pp.payment_status='paid_now'),0::numeric)
    + COALESCE((SELECT sum(pe.amount) FROM finance.partner_expenses pe
      WHERE pe.environment=pu.environment AND pe.unit_id=pu.unit_id
        AND pe.deleted_at IS NULL AND pe.expense_date>=mb.month_start_date
        AND pe.source_payable_id IS NULL),0::numeric)
    + COALESCE((SELECT sum(pp2.amount) FROM finance.partner_payables pp2
      WHERE pp2.environment=pu.environment AND pp2.unit_id=pu.unit_id
        AND pp2.deleted_at IS NULL AND pp2.status='paid'
        AND pp2.paid_at>=mb.month_start_at),0::numeric) AS total
) cash_out_month ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(pre.amount),0::numeric) AS total
    FROM finance.partner_receivables_effective pre
   WHERE pre.environment=pu.environment AND pre.unit_id=pu.unit_id
     AND pre.status='open'
) open_recv ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(pp3.amount),0::numeric) AS total
    FROM finance.partner_payables pp3
   WHERE pp3.environment=pu.environment AND pp3.unit_id=pu.unit_id
     AND pp3.status='open' AND pp3.deleted_at IS NULL
) open_pay ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS stock_items,
         count(*) FILTER (WHERE ps.stock_status=ANY(
           ARRAY['low_stock','out_of_stock']))::integer AS low_stock_items
    FROM commerce.partner_stock_levels ps
   WHERE ps.environment=pu.environment AND ps.unit_id=pu.unit_id
     AND ps.deleted_at IS NULL
) stock_counts ON true
WHERE pu.deleted_at IS NULL;

COMMENT ON VIEW network.partner_unit_summary IS
  'Resumo mensal do parceiro: competencia em Sao Paulo, CMV historico, comissoes congeladas e caixa separado.';
GRANT SELECT ON network.partner_unit_summary TO farejador_partner_app;
