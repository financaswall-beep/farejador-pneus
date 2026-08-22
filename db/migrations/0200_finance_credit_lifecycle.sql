-- 0200 - Ciclo de credito, caixa realizado e inadimplencia.
--
-- Mantem receita/custo no regime de competencia, mas registra dinheiro somente
-- quando existe um evento imutavel de recebimento/pagamento. Tambem permite
-- baixa parcial e perda de credito sem apagar a venda que originou o titulo.

ALTER TABLE finance.partner_receivables
  DROP CONSTRAINT IF EXISTS partner_receivables_status_check;
ALTER TABLE finance.partner_receivables
  ADD CONSTRAINT partner_receivables_status_check
  CHECK (status IN ('open','received','resolved','written_off','cancelled'));

CREATE TABLE finance.partner_receivable_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  unit_id UUID NOT NULL REFERENCES core.units(id),
  receivable_id UUID NOT NULL REFERENCES finance.partner_receivables(id),
  installment_id UUID REFERENCES finance.partner_receivable_installments(id),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('receipt','writeoff','recovery','refund')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount>0),
  occurred_at TIMESTAMPTZ NOT NULL,
  payment_method TEXT,
  reason TEXT,
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_receivable_events_idempotency_uniq
    UNIQUE (environment,idempotency_key),
  CONSTRAINT partner_receivable_events_details_check CHECK (
    (event_kind IN ('receipt','recovery','refund') AND payment_method IS NOT NULL
      AND length(btrim(payment_method)) BETWEEN 1 AND 80)
    OR
    (event_kind='writeoff' AND reason IS NOT NULL
      AND length(btrim(reason)) BETWEEN 3 AND 500)
  )
);

CREATE INDEX partner_receivable_events_target_idx
  ON finance.partner_receivable_events(
    environment,receivable_id,installment_id,event_kind,occurred_at
  );

CREATE TABLE finance.partner_payable_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  unit_id UUID NOT NULL REFERENCES core.units(id),
  payable_id UUID NOT NULL REFERENCES finance.partner_payables(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount>0),
  paid_at TIMESTAMPTZ NOT NULL,
  payment_method TEXT NOT NULL CHECK (length(btrim(payment_method)) BETWEEN 1 AND 80),
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_payable_events_idempotency_uniq
    UNIQUE (environment,idempotency_key)
);

CREATE INDEX partner_payable_events_target_idx
  ON finance.partner_payable_events(environment,payable_id,paid_at);

CREATE TABLE finance.partner_order_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  unit_id UUID NOT NULL REFERENCES core.units(id),
  order_id UUID NOT NULL REFERENCES commerce.partner_orders(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount>0),
  refunded_at TIMESTAMPTZ NOT NULL,
  payment_method TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment,order_id)
);

CREATE TRIGGER env_match_partner_receivable_event_unit
  BEFORE INSERT OR UPDATE OF environment,unit_id
  ON finance.partner_receivable_events
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','units','unit_id');
CREATE TRIGGER env_match_partner_receivable_event_parent
  BEFORE INSERT OR UPDATE OF environment,receivable_id
  ON finance.partner_receivable_events
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','partner_receivables','receivable_id');
CREATE TRIGGER env_match_partner_receivable_event_installment
  BEFORE INSERT OR UPDATE OF environment,installment_id
  ON finance.partner_receivable_events
  FOR EACH ROW
  WHEN (NEW.installment_id IS NOT NULL)
  EXECUTE FUNCTION ops.validate_env_match(
    'finance','partner_receivable_installments','installment_id');
CREATE TRIGGER env_match_partner_payable_event_unit
  BEFORE INSERT OR UPDATE OF environment,unit_id
  ON finance.partner_payable_events
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','units','unit_id');
CREATE TRIGGER env_match_partner_payable_event_parent
  BEFORE INSERT OR UPDATE OF environment,payable_id
  ON finance.partner_payable_events
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','partner_payables','payable_id');
CREATE TRIGGER env_match_partner_order_refund_unit
  BEFORE INSERT OR UPDATE OF environment,unit_id ON finance.partner_order_refunds
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','units','unit_id');
CREATE TRIGGER env_match_partner_order_refund_order
  BEFORE INSERT OR UPDATE OF environment,order_id ON finance.partner_order_refunds
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','partner_orders','order_id');

CREATE TRIGGER partner_receivable_events_business_time_guard
  BEFORE INSERT ON finance.partner_receivable_events
  FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('occurred_at');
CREATE TRIGGER partner_payable_events_business_time_guard
  BEFORE INSERT ON finance.partner_payable_events
  FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('paid_at');
CREATE TRIGGER partner_order_refunds_business_time_guard
  BEFORE INSERT ON finance.partner_order_refunds
  FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('refunded_at');

CREATE TRIGGER partner_receivable_events_immutable
  BEFORE UPDATE OR DELETE ON finance.partner_receivable_events
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_ledger_immutable();
CREATE TRIGGER partner_payable_events_immutable
  BEFORE UPDATE OR DELETE ON finance.partner_payable_events
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_ledger_immutable();
CREATE TRIGGER partner_order_refunds_immutable
  BEFORE UPDATE OR DELETE ON finance.partner_order_refunds
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_ledger_immutable();

ALTER TABLE finance.partner_receivable_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.partner_payable_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.partner_order_refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY partner_receivable_events_isolation
  ON finance.partner_receivable_events FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL
    AND unit_id=network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL
    AND unit_id=network.current_partner_core_unit());
CREATE POLICY partner_payable_events_isolation
  ON finance.partner_payable_events FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL
    AND unit_id=network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL
    AND unit_id=network.current_partner_core_unit());
CREATE POLICY partner_order_refunds_isolation
  ON finance.partner_order_refunds FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL
    AND unit_id=network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL
    AND unit_id=network.current_partner_core_unit());

GRANT SELECT,INSERT ON finance.partner_receivable_events TO farejador_partner_app;
GRANT SELECT,INSERT ON finance.partner_payable_events TO farejador_partner_app;
GRANT SELECT ON finance.partner_order_refunds TO farejador_partner_app;

CREATE OR REPLACE FUNCTION finance.validate_partner_receivable_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,finance
AS $fn$
DECLARE
  v_parent finance.partner_receivables%ROWTYPE;
  v_target_amount NUMERIC(12,2);
  v_receipts NUMERIC(12,2);
  v_writeoffs NUMERIC(12,2);
  v_recoveries NUMERIC(12,2);
  v_cash NUMERIC(12,2);
BEGIN
  SELECT * INTO v_parent
    FROM finance.partner_receivables
   WHERE environment=NEW.environment AND id=NEW.receivable_id
   FOR UPDATE;
  IF NOT FOUND OR v_parent.unit_id<>NEW.unit_id
     OR (v_parent.deleted_at IS NOT NULL AND NEW.event_kind<>'refund') THEN
    RAISE EXCEPTION 'partner_receivable_event_parent_invalid' USING ERRCODE='23514';
  END IF;

  IF NEW.installment_id IS NULL THEN
    IF NEW.event_kind<>'refund' AND EXISTS (SELECT 1 FROM finance.partner_receivable_installments i
      WHERE i.environment=NEW.environment AND i.receivable_id=NEW.receivable_id
        AND i.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'partner_receivable_event_installment_required' USING ERRCODE='23514';
    END IF;
    v_target_amount := v_parent.amount;
  ELSE
    SELECT i.amount INTO v_target_amount
      FROM finance.partner_receivable_installments i
     WHERE i.environment=NEW.environment AND i.id=NEW.installment_id
       AND i.receivable_id=NEW.receivable_id AND i.deleted_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'partner_receivable_event_installment_invalid' USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT COALESCE(sum(amount) FILTER (WHERE event_kind='receipt'),0),
         COALESCE(sum(amount) FILTER (WHERE event_kind='writeoff'),0),
         COALESCE(sum(amount) FILTER (WHERE event_kind='recovery'),0)
    INTO v_receipts,v_writeoffs,v_recoveries
    FROM finance.partner_receivable_events e
   WHERE e.environment=NEW.environment AND e.receivable_id=NEW.receivable_id
     AND e.installment_id IS NOT DISTINCT FROM NEW.installment_id;

  IF NEW.event_kind IN ('receipt','writeoff')
     AND v_receipts+v_writeoffs+NEW.amount>v_target_amount THEN
    RAISE EXCEPTION 'partner_receivable_event_exceeds_balance' USING ERRCODE='23514';
  END IF;
  IF NEW.event_kind='recovery' AND v_recoveries+NEW.amount>v_writeoffs THEN
    RAISE EXCEPTION 'partner_receivable_recovery_exceeds_writeoff' USING ERRCODE='23514';
  END IF;
  IF NEW.event_kind='refund' THEN
    SELECT COALESCE(sum(CASE WHEN event_kind IN ('receipt','recovery') THEN amount
      WHEN event_kind='refund' THEN -amount ELSE 0 END),0) INTO v_cash
      FROM finance.partner_receivable_events prior
     WHERE prior.environment=NEW.environment
       AND prior.receivable_id=NEW.receivable_id;
    IF NEW.amount>v_cash THEN
      RAISE EXCEPTION 'partner_receivable_refund_exceeds_cash' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER partner_receivable_event_integrity
  BEFORE INSERT ON finance.partner_receivable_events
  FOR EACH ROW EXECUTE FUNCTION finance.validate_partner_receivable_event();

CREATE OR REPLACE FUNCTION finance.sync_partner_receivable_event_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,finance
AS $fn$
DECLARE
  v_target_amount NUMERIC(12,2);
  v_receipts NUMERIC(12,2);
  v_writeoffs NUMERIC(12,2);
  v_total_lines INTEGER;
  v_open_lines INTEGER;
  v_received_lines INTEGER;
  v_written_lines INTEGER;
  v_last_receipt TIMESTAMPTZ;
  v_last_method TEXT;
BEGIN
  PERFORM set_config('app.partner_receivable_operation','on',true);
  IF NEW.event_kind='refund' THEN RETURN NEW; END IF;
  IF NEW.installment_id IS NOT NULL THEN
    SELECT amount INTO v_target_amount
      FROM finance.partner_receivable_installments WHERE id=NEW.installment_id;
    SELECT COALESCE(sum(amount) FILTER (WHERE event_kind='receipt'),0),
           COALESCE(sum(amount) FILTER (WHERE event_kind='writeoff'),0),
           max(occurred_at) FILTER (WHERE event_kind='receipt'),
           (array_agg(payment_method ORDER BY occurred_at DESC,id DESC)
             FILTER (WHERE event_kind='receipt'))[1]
      INTO v_receipts,v_writeoffs,v_last_receipt,v_last_method
      FROM finance.partner_receivable_events
     WHERE environment=NEW.environment AND receivable_id=NEW.receivable_id
       AND installment_id=NEW.installment_id;
    UPDATE finance.partner_receivable_installments
       SET status=CASE
             WHEN v_receipts=v_target_amount THEN 'received'
             WHEN v_writeoffs=v_target_amount THEN 'cancelled'
             WHEN v_receipts+v_writeoffs=v_target_amount THEN 'cancelled'
             ELSE 'open' END,
           received_at=CASE WHEN v_receipts=v_target_amount THEN v_last_receipt ELSE NULL END,
           payment_method=CASE WHEN v_receipts=v_target_amount THEN v_last_method ELSE NULL END
     WHERE id=NEW.installment_id;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE resolved_amount<amount),
         count(*) FILTER (WHERE receipts=amount),
         count(*) FILTER (WHERE writeoffs=amount)
    INTO v_total_lines,v_open_lines,v_received_lines,v_written_lines
    FROM (
      SELECT i.amount,
             COALESCE(sum(e.amount) FILTER (WHERE e.event_kind='receipt'),0) receipts,
             COALESCE(sum(e.amount) FILTER (WHERE e.event_kind='writeoff'),0) writeoffs,
             COALESCE(sum(e.amount) FILTER (WHERE e.event_kind IN ('receipt','writeoff')),0) resolved_amount
        FROM finance.partner_receivable_installments i
        LEFT JOIN finance.partner_receivable_events e
          ON e.environment=i.environment AND e.receivable_id=i.receivable_id
         AND e.installment_id=i.id
       WHERE i.environment=NEW.environment AND i.receivable_id=NEW.receivable_id
         AND i.deleted_at IS NULL
       GROUP BY i.id,i.amount
    ) lines;

  IF v_total_lines=0 THEN
    SELECT p.amount,
           COALESCE(sum(e.amount) FILTER (WHERE e.event_kind='receipt'),0),
           COALESCE(sum(e.amount) FILTER (WHERE e.event_kind='writeoff'),0),
           max(e.occurred_at) FILTER (WHERE e.event_kind='receipt'),
           (array_agg(e.payment_method ORDER BY e.occurred_at DESC,e.id DESC)
             FILTER (WHERE e.event_kind='receipt'))[1]
      INTO v_target_amount,v_receipts,v_writeoffs,v_last_receipt,v_last_method
      FROM finance.partner_receivables p
      LEFT JOIN finance.partner_receivable_events e
        ON e.environment=p.environment AND e.receivable_id=p.id
       AND e.installment_id IS NULL
     WHERE p.environment=NEW.environment AND p.id=NEW.receivable_id
     GROUP BY p.id,p.amount;
    UPDATE finance.partner_receivables
       SET status=CASE
             WHEN v_receipts=v_target_amount THEN 'received'
             WHEN v_writeoffs=v_target_amount THEN 'written_off'
             WHEN v_receipts+v_writeoffs=v_target_amount THEN 'resolved'
             ELSE 'open' END,
           received_at=CASE WHEN v_receipts=v_target_amount THEN v_last_receipt ELSE NULL END,
           payment_method=CASE WHEN v_receipts=v_target_amount THEN v_last_method ELSE NULL END
     WHERE environment=NEW.environment AND id=NEW.receivable_id;
  ELSE
    SELECT max(e.occurred_at),
           (array_agg(e.payment_method ORDER BY e.occurred_at DESC,e.id DESC)
             FILTER (WHERE e.event_kind='receipt'))[1]
      INTO v_last_receipt,v_last_method
      FROM finance.partner_receivable_events e
     WHERE e.environment=NEW.environment AND e.receivable_id=NEW.receivable_id;
    UPDATE finance.partner_receivables
       SET status=CASE
             WHEN v_open_lines>0 THEN 'open'
             WHEN v_received_lines=v_total_lines THEN 'received'
             WHEN v_written_lines=v_total_lines THEN 'written_off'
             ELSE 'resolved' END,
           received_at=CASE WHEN v_received_lines=v_total_lines THEN v_last_receipt ELSE NULL END,
           payment_method=CASE WHEN v_received_lines=v_total_lines THEN v_last_method ELSE NULL END
     WHERE environment=NEW.environment AND id=NEW.receivable_id;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER partner_receivable_event_sync
  AFTER INSERT ON finance.partner_receivable_events
  FOR EACH ROW EXECUTE FUNCTION finance.sync_partner_receivable_event_state();

CREATE OR REPLACE FUNCTION finance.validate_partner_payable_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,finance
AS $fn$
DECLARE
  v_payable finance.partner_payables%ROWTYPE;
  v_paid NUMERIC(12,2);
BEGIN
  SELECT * INTO v_payable FROM finance.partner_payables
   WHERE environment=NEW.environment AND id=NEW.payable_id FOR UPDATE;
  IF NOT FOUND OR v_payable.unit_id<>NEW.unit_id OR v_payable.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'partner_payable_event_parent_invalid' USING ERRCODE='23514';
  END IF;
  IF session_user='farejador_partner_app'
     AND v_payable.source_purchase_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM commerce.partner_purchases purchase
       WHERE purchase.environment=v_payable.environment
         AND purchase.id=v_payable.source_purchase_id
         AND purchase.source_wholesale_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'matrix_linked_payable_managed_by_matrix' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(amount),0) INTO v_paid
    FROM finance.partner_payable_events
   WHERE environment=NEW.environment AND payable_id=NEW.payable_id;
  IF v_paid+NEW.amount>v_payable.amount THEN
    RAISE EXCEPTION 'partner_payable_event_exceeds_balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER partner_payable_event_integrity
  BEFORE INSERT ON finance.partner_payable_events
  FOR EACH ROW EXECUTE FUNCTION finance.validate_partner_payable_event();

CREATE OR REPLACE FUNCTION finance.sync_partner_payable_event_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,finance
AS $fn$
DECLARE
  v_amount NUMERIC(12,2);
  v_paid NUMERIC(12,2);
  v_paid_at TIMESTAMPTZ;
  v_method TEXT;
BEGIN
  SELECT p.amount,COALESCE(sum(e.amount),0),max(e.paid_at),
         (array_agg(e.payment_method ORDER BY e.paid_at DESC,e.id DESC))[1]
    INTO v_amount,v_paid,v_paid_at,v_method
    FROM finance.partner_payables p
    LEFT JOIN finance.partner_payable_events e
      ON e.environment=p.environment AND e.payable_id=p.id
   WHERE p.environment=NEW.environment AND p.id=NEW.payable_id
   GROUP BY p.id,p.amount;
  PERFORM set_config('app.matrix_partner_bridge','on',true);
  UPDATE finance.partner_payables
     SET status=CASE WHEN v_paid=v_amount THEN 'paid' ELSE 'open' END,
         paid_at=CASE WHEN v_paid=v_amount THEN v_paid_at ELSE NULL END,
         payment_method=CASE WHEN v_paid=v_amount THEN v_method ELSE NULL END
   WHERE environment=NEW.environment AND id=NEW.payable_id;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER partner_payable_event_sync
  AFTER INSERT ON finance.partner_payable_events
  FOR EACH ROW EXECUTE FUNCTION finance.sync_partner_payable_event_state();

-- Compatibilidade: writers antigos que fecham o cabecalho continuam gerando o
-- evento de caixa. Writers novos inserem o evento primeiro e nao duplicam.
CREATE OR REPLACE FUNCTION finance.capture_partner_receivable_closed_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,finance
AS $fn$
BEGIN
  IF NEW.status='received' AND NEW.received_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM finance.partner_receivable_installments i
       WHERE i.environment=NEW.environment AND i.receivable_id=NEW.id
         AND i.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM finance.partner_receivable_events e
       WHERE e.environment=NEW.environment AND e.receivable_id=NEW.id
         AND e.installment_id IS NULL AND e.event_kind='receipt') THEN
    INSERT INTO finance.partner_receivable_events
      (environment,unit_id,receivable_id,event_kind,amount,occurred_at,
       payment_method,idempotency_key,created_by)
    VALUES
      (NEW.environment,NEW.unit_id,NEW.id,'receipt',NEW.amount,NEW.received_at,
       COALESCE(NULLIF(btrim(NEW.payment_method),''),'Nao informado'),
       'legacy-receivable:'||NEW.id,COALESCE(NEW.created_by,'system:legacy'));
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER partner_receivable_capture_closed_state
  AFTER INSERT OR UPDATE OF status,received_at ON finance.partner_receivables
  FOR EACH ROW EXECUTE FUNCTION finance.capture_partner_receivable_closed_state();

CREATE OR REPLACE FUNCTION finance.capture_partner_installment_closed_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,finance
AS $fn$
DECLARE v_parent finance.partner_receivables%ROWTYPE;
BEGIN
  IF NEW.status='received' AND NEW.received_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM finance.partner_receivable_events e
       WHERE e.environment=NEW.environment AND e.installment_id=NEW.id
         AND e.event_kind='receipt') THEN
    SELECT * INTO STRICT v_parent FROM finance.partner_receivables
     WHERE environment=NEW.environment AND id=NEW.receivable_id;
    INSERT INTO finance.partner_receivable_events
      (environment,unit_id,receivable_id,installment_id,event_kind,amount,
       occurred_at,payment_method,idempotency_key,created_by)
    VALUES
      (NEW.environment,v_parent.unit_id,NEW.receivable_id,NEW.id,'receipt',NEW.amount,
       NEW.received_at,COALESCE(NULLIF(btrim(NEW.payment_method),''),'Nao informado'),
       'legacy-installment:'||NEW.id,COALESCE(v_parent.created_by,'system:legacy'));
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER partner_installment_capture_closed_state
  AFTER INSERT OR UPDATE OF status,received_at
  ON finance.partner_receivable_installments
  FOR EACH ROW EXECUTE FUNCTION finance.capture_partner_installment_closed_state();

CREATE OR REPLACE FUNCTION finance.capture_partner_payable_closed_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,finance
AS $fn$
BEGIN
  IF NEW.status='paid' AND NEW.paid_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM finance.partner_payable_events e
       WHERE e.environment=NEW.environment AND e.payable_id=NEW.id) THEN
    INSERT INTO finance.partner_payable_events
      (environment,unit_id,payable_id,amount,paid_at,payment_method,
       idempotency_key,created_by)
    VALUES
      (NEW.environment,NEW.unit_id,NEW.id,NEW.amount,NEW.paid_at,
       COALESCE(NULLIF(btrim(NEW.payment_method),''),'Nao informado'),
       'legacy-payable:'||NEW.id,COALESCE(NEW.created_by,'system:legacy'));
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER partner_payable_capture_closed_state
  AFTER INSERT OR UPDATE OF status,paid_at ON finance.partner_payables
  FOR EACH ROW EXECUTE FUNCTION finance.capture_partner_payable_closed_state();

CREATE OR REPLACE FUNCTION finance.capture_partner_receivable_cancel_refund()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,finance
AS $fn$
DECLARE v_refund NUMERIC(12,2);
DECLARE v_method TEXT;
BEGIN
  IF NEW.status='cancelled' AND OLD.status<>'cancelled' THEN
    SELECT COALESCE(sum(CASE WHEN event_kind IN ('receipt','recovery') THEN amount
      WHEN event_kind='refund' THEN -amount ELSE 0 END),0),
      (array_agg(payment_method ORDER BY occurred_at DESC,id DESC)
        FILTER (WHERE event_kind IN ('receipt','recovery')))[1]
      INTO v_refund,v_method
      FROM finance.partner_receivable_events e
     WHERE e.environment=NEW.environment AND e.receivable_id=NEW.id;
    IF v_refund>0 THEN
      INSERT INTO finance.partner_receivable_events
        (environment,unit_id,receivable_id,event_kind,amount,occurred_at,
         payment_method,reason,idempotency_key,created_by)
      VALUES (NEW.environment,NEW.unit_id,NEW.id,'refund',v_refund,now(),
        COALESCE(v_method,'Nao informado'),'Estorno por cancelamento da venda',
        'sale-cancel-refund:'||NEW.id,COALESCE(NEW.deleted_by,'system:cancel'))
      ON CONFLICT (environment,idempotency_key) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER partner_receivable_cancel_refund
  AFTER UPDATE OF status ON finance.partner_receivables
  FOR EACH ROW EXECUTE FUNCTION finance.capture_partner_receivable_cancel_refund();

CREATE OR REPLACE FUNCTION finance.capture_partner_order_cash_refund()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,finance,commerce
AS $fn$
BEGIN
  IF NEW.status='cancelled' AND OLD.status<>'cancelled'
     AND NOT OLD.awaiting_pickup
     AND (OLD.fulfillment_mode<>'delivery' OR OLD.delivered_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM finance.partner_receivables r
       WHERE r.environment=OLD.environment AND r.source_order_id=OLD.id) THEN
    INSERT INTO finance.partner_order_refunds
      (environment,unit_id,order_id,amount,refunded_at,payment_method,
       reason,created_by)
    VALUES (OLD.environment,OLD.unit_id,OLD.id,OLD.total_amount,now(),
      COALESCE(NULLIF(btrim(OLD.payment_method),''),'Nao informado'),
      'Cancelamento de venda realizada',COALESCE(NEW.closed_by,'system:cancel'))
    ON CONFLICT (environment,order_id) DO NOTHING;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER partner_order_cash_refund
  AFTER UPDATE OF status ON commerce.partner_orders
  FOR EACH ROW EXECUTE FUNCTION finance.capture_partner_order_cash_refund();

-- Backfill historico: cada titulo fechado vira um evento imutavel, sem criar ou
-- antecipar dinheiro para titulos ainda abertos.
INSERT INTO finance.partner_receivable_events
  (environment,unit_id,receivable_id,event_kind,amount,occurred_at,
   payment_method,idempotency_key,created_by)
SELECT r.environment,r.unit_id,r.id,'receipt',r.amount,r.received_at,
       COALESCE(NULLIF(btrim(r.payment_method),''),'Nao informado'),
       'legacy-receivable:'||r.id,COALESCE(r.created_by,'system:legacy')
  FROM finance.partner_receivables r
 WHERE r.status='received' AND r.received_at IS NOT NULL AND r.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM finance.partner_receivable_installments i
     WHERE i.environment=r.environment AND i.receivable_id=r.id AND i.deleted_at IS NULL)
ON CONFLICT (environment,idempotency_key) DO NOTHING;

INSERT INTO finance.partner_order_refunds
  (environment,unit_id,order_id,amount,refunded_at,payment_method,reason,created_by)
SELECT o.environment,o.unit_id,o.id,o.total_amount,o.updated_at,
       COALESCE(NULLIF(btrim(o.payment_method),''),'Nao informado'),
       'Cancelamento historico de venda realizada','system:0200-backfill'
  FROM commerce.partner_orders o
 WHERE o.status='cancelled' AND o.deleted_at IS NULL
   AND NOT o.awaiting_pickup
   AND (o.fulfillment_mode<>'delivery' OR o.delivered_at IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM finance.partner_receivables r
     WHERE r.environment=o.environment AND r.source_order_id=o.id)
ON CONFLICT (environment,order_id) DO NOTHING;

INSERT INTO finance.partner_receivable_events
  (environment,unit_id,receivable_id,installment_id,event_kind,amount,occurred_at,
   payment_method,idempotency_key,created_by)
SELECT i.environment,r.unit_id,r.id,i.id,'receipt',i.amount,i.received_at,
       COALESCE(NULLIF(btrim(i.payment_method),''),'Nao informado'),
       'legacy-installment:'||i.id,COALESCE(r.created_by,'system:legacy')
  FROM finance.partner_receivable_installments i
  JOIN finance.partner_receivables r
    ON r.environment=i.environment AND r.id=i.receivable_id
 WHERE i.status='received' AND i.received_at IS NOT NULL
   AND i.deleted_at IS NULL AND r.deleted_at IS NULL
ON CONFLICT (environment,idempotency_key) DO NOTHING;

INSERT INTO finance.partner_payable_events
  (environment,unit_id,payable_id,amount,paid_at,payment_method,
   idempotency_key,created_by)
SELECT p.environment,p.unit_id,p.id,p.amount,p.paid_at,
       COALESCE(NULLIF(btrim(p.payment_method),''),'Nao informado'),
       'legacy-payable:'||p.id,COALESCE(p.created_by,'system:legacy')
  FROM finance.partner_payables p
 WHERE p.status='paid' AND p.paid_at IS NOT NULL AND p.deleted_at IS NULL
ON CONFLICT (environment,idempotency_key) DO NOTHING;

-- Titulo automatico de venda nao pode ser reescrito como se fosse avulso.
CREATE OR REPLACE FUNCTION finance.guard_source_linked_partner_receivable()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.source_order_id IS NOT NULL
     AND ROW(NEW.environment,NEW.unit_id,NEW.customer_id,NEW.customer_name,
             NEW.description,NEW.source_tag,NEW.amount,NEW.due_date,
             NEW.source_order_id)
       IS DISTINCT FROM
         ROW(OLD.environment,OLD.unit_id,OLD.customer_id,OLD.customer_name,
             OLD.description,OLD.source_tag,OLD.amount,OLD.due_date,
             OLD.source_order_id)
     AND COALESCE(current_setting('app.partner_receivable_operation',true),'')<>'on' THEN
    RAISE EXCEPTION 'source_linked_receivable_managed_by_sale' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER source_linked_partner_receivable_guard
  BEFORE UPDATE ON finance.partner_receivables
  FOR EACH ROW EXECUTE FUNCTION finance.guard_source_linked_partner_receivable();

CREATE OR REPLACE VIEW finance.partner_receivables_effective
WITH (security_invoker=true) AS
SELECT pr.id receivable_id,NULL::uuid installment_id,pr.environment,pr.unit_id,
       pr.amount,pr.due_date,pr.status,pr.received_at,pr.source_order_id,
       pr.source_tag,pr.created_at,
       COALESCE(ev.received_amount,0)::numeric(12,2) received_amount,
       COALESCE(ev.written_off_amount,0)::numeric(12,2) written_off_amount,
       GREATEST(pr.amount-COALESCE(ev.received_amount,0)
         -COALESCE(ev.written_off_amount,0),0)::numeric(12,2) open_amount
  FROM finance.partner_receivables pr
  LEFT JOIN LATERAL (
    SELECT sum(amount) FILTER (WHERE event_kind='receipt') received_amount,
           sum(amount) FILTER (WHERE event_kind='writeoff') written_off_amount
      FROM finance.partner_receivable_events e
     WHERE e.environment=pr.environment AND e.receivable_id=pr.id
       AND e.installment_id IS NULL
  ) ev ON true
 WHERE pr.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM finance.partner_receivable_installments i
     WHERE i.receivable_id=pr.id AND i.deleted_at IS NULL)
UNION ALL
SELECT i.receivable_id,i.id,i.environment,pr.unit_id,i.amount,i.due_date,
       i.status,i.received_at,pr.source_order_id,pr.source_tag,i.created_at,
       COALESCE(ev.received_amount,0)::numeric(12,2),
       COALESCE(ev.written_off_amount,0)::numeric(12,2),
       GREATEST(i.amount-COALESCE(ev.received_amount,0)
         -COALESCE(ev.written_off_amount,0),0)::numeric(12,2)
  FROM finance.partner_receivable_installments i
  JOIN finance.partner_receivables pr ON pr.id=i.receivable_id
  LEFT JOIN LATERAL (
    SELECT sum(amount) FILTER (WHERE event_kind='receipt') received_amount,
           sum(amount) FILTER (WHERE event_kind='writeoff') written_off_amount
      FROM finance.partner_receivable_events e
     WHERE e.environment=i.environment AND e.receivable_id=i.receivable_id
       AND e.installment_id=i.id
  ) ev ON true
 WHERE i.deleted_at IS NULL AND pr.deleted_at IS NULL;

CREATE OR REPLACE VIEW finance.partner_payables_effective
WITH (security_invoker=true) AS
SELECT p.*,
       COALESCE(ev.paid_amount,0)::numeric(12,2) paid_amount,
       GREATEST(p.amount-COALESCE(ev.paid_amount,0),0)::numeric(12,2) open_amount
  FROM finance.partner_payables p
  LEFT JOIN LATERAL (
    SELECT sum(amount) paid_amount FROM finance.partner_payable_events e
     WHERE e.environment=p.environment AND e.payable_id=p.id
  ) ev ON true
 WHERE p.deleted_at IS NULL;

GRANT SELECT ON finance.partner_receivables_effective TO farejador_partner_app;
GRANT SELECT ON finance.partner_payables_effective TO farejador_partner_app;

CREATE OR REPLACE VIEW network.partner_cash_flow_projection
WITH (security_invoker=true) AS
WITH today_bound AS (
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date today
), recv AS (
  SELECT r.environment,r.unit_id,CASE
    WHEN r.due_date IS NULL THEN 'later'
    WHEN r.due_date<t.today THEN 'overdue'
    WHEN r.due_date=t.today THEN 'today'
    WHEN r.due_date<=t.today+7 THEN 'next_7d'
    WHEN r.due_date<=t.today+30 THEN 'next_30d' ELSE 'later' END bucket,
    r.open_amount amount
  FROM finance.partner_receivables_effective r CROSS JOIN today_bound t
  WHERE r.open_amount>0
), pay AS (
  SELECT p.environment,p.unit_id,CASE
    WHEN p.due_date IS NULL THEN 'later'
    WHEN p.due_date<t.today THEN 'overdue'
    WHEN p.due_date=t.today THEN 'today'
    WHEN p.due_date<=t.today+7 THEN 'next_7d'
    WHEN p.due_date<=t.today+30 THEN 'next_30d' ELSE 'later' END bucket,
    p.open_amount amount
  FROM finance.partner_payables_effective p CROSS JOIN today_bound t
  WHERE p.open_amount>0
), recv_agg AS (
  SELECT environment,unit_id,
    COALESCE(sum(amount) FILTER (WHERE bucket='overdue'),0) overdue_in,
    COALESCE(sum(amount) FILTER (WHERE bucket='today'),0) today_in,
    COALESCE(sum(amount) FILTER (WHERE bucket='next_7d'),0) next_7d_in,
    COALESCE(sum(amount) FILTER (WHERE bucket='next_30d'),0) next_30d_in,
    COALESCE(sum(amount) FILTER (WHERE bucket='later'),0) later_in,
    count(*) FILTER (WHERE bucket='overdue')::int overdue_in_count,
    count(*) FILTER (WHERE bucket='today')::int today_in_count,
    count(*) FILTER (WHERE bucket='next_7d')::int next_7d_in_count,
    count(*) FILTER (WHERE bucket='next_30d')::int next_30d_in_count,
    count(*) FILTER (WHERE bucket='later')::int later_in_count
  FROM recv GROUP BY environment,unit_id
), pay_agg AS (
  SELECT environment,unit_id,
    COALESCE(sum(amount) FILTER (WHERE bucket='overdue'),0) overdue_out,
    COALESCE(sum(amount) FILTER (WHERE bucket='today'),0) today_out,
    COALESCE(sum(amount) FILTER (WHERE bucket='next_7d'),0) next_7d_out,
    COALESCE(sum(amount) FILTER (WHERE bucket='next_30d'),0) next_30d_out,
    COALESCE(sum(amount) FILTER (WHERE bucket='later'),0) later_out,
    count(*) FILTER (WHERE bucket='overdue')::int overdue_out_count,
    count(*) FILTER (WHERE bucket='today')::int today_out_count,
    count(*) FILTER (WHERE bucket='next_7d')::int next_7d_out_count,
    count(*) FILTER (WHERE bucket='next_30d')::int next_30d_out_count,
    count(*) FILTER (WHERE bucket='later')::int later_out_count
  FROM pay GROUP BY environment,unit_id
)
SELECT pu.environment,pu.id partner_unit_id,pu.unit_id,pu.slug,
  COALESCE(r.overdue_in,0) overdue_in,COALESCE(p.overdue_out,0) overdue_out,
  COALESCE(r.overdue_in,0)-COALESCE(p.overdue_out,0) overdue_net,
  COALESCE(r.overdue_in_count,0) overdue_in_count,
  COALESCE(p.overdue_out_count,0) overdue_out_count,
  COALESCE(r.today_in,0) today_in,COALESCE(p.today_out,0) today_out,
  COALESCE(r.today_in,0)-COALESCE(p.today_out,0) today_net,
  COALESCE(r.today_in_count,0) today_in_count,COALESCE(p.today_out_count,0) today_out_count,
  COALESCE(r.next_7d_in,0) next_7d_in,COALESCE(p.next_7d_out,0) next_7d_out,
  COALESCE(r.next_7d_in,0)-COALESCE(p.next_7d_out,0) next_7d_net,
  COALESCE(r.next_7d_in_count,0) next_7d_in_count,
  COALESCE(p.next_7d_out_count,0) next_7d_out_count,
  COALESCE(r.next_30d_in,0) next_30d_in,COALESCE(p.next_30d_out,0) next_30d_out,
  COALESCE(r.next_30d_in,0)-COALESCE(p.next_30d_out,0) next_30d_net,
  COALESCE(r.next_30d_in_count,0) next_30d_in_count,
  COALESCE(p.next_30d_out_count,0) next_30d_out_count,
  COALESCE(r.later_in,0) later_in,COALESCE(p.later_out,0) later_out,
  COALESCE(r.later_in,0)-COALESCE(p.later_out,0) later_net,
  COALESCE(r.later_in_count,0) later_in_count,COALESCE(p.later_out_count,0) later_out_count
FROM network.partner_units pu
LEFT JOIN recv_agg r ON r.environment=pu.environment AND r.unit_id=pu.unit_id
LEFT JOIN pay_agg p ON p.environment=pu.environment AND p.unit_id=pu.unit_id
WHERE pu.deleted_at IS NULL;

GRANT SELECT ON network.partner_cash_flow_projection TO farejador_partner_app;

-- O resumo preserva competencia e troca a lente de caixa por eventos reais.
CREATE OR REPLACE VIEW network.partner_unit_summary
WITH (security_invoker=true) AS
WITH month_bounds AS (
  SELECT (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
      AT TIME ZONE 'America/Sao_Paulo') month_start_at,
    date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date month_start_date
)
SELECT pu.environment,pu.id partner_unit_id,pu.unit_id,pu.slug,pu.display_name,
  p.id partner_id,p.trade_name partner_name,p.status partner_status,pu.status unit_status,
  COALESCE(sales.total_sales,0::numeric) sales_month,
  COALESCE(sales.order_count,0) orders_month,
  COALESCE(purchases.total_purchases,0::numeric) purchases_month,
  COALESCE(expenses.total_expenses,0::numeric) expenses_month,
  CASE WHEN COALESCE(cogs.pending_count,0)=0 THEN COALESCE(sales.total_sales,0)
    -COALESCE(cogs.known_total,0)-COALESCE(expenses.total_expenses,0) END result_competencia_month,
  CASE WHEN COALESCE(cogs.pending_count,0)=0 THEN COALESCE(sales.total_sales,0)
    -COALESCE(cogs.known_total,0)-COALESCE(expenses.total_expenses,0) END estimated_result_month,
  COALESCE(cash_in.total,0::numeric) cash_in_month,
  COALESCE(cash_out.total,0::numeric) cash_out_month,
  COALESCE(cash_in.total,0)-COALESCE(cash_out.total,0) cash_net_month,
  COALESCE(open_recv.total,0::numeric) open_receivables_total,
  COALESCE(open_pay.total,0::numeric) open_payables_total,
  COALESCE(open_recv.total,0)-COALESCE(open_pay.total,0) net_future_position,
  COALESCE(stock.stock_items,0) stock_items,COALESCE(stock.low_stock_items,0) low_stock_items,
  COALESCE(cogs.known_total,0::numeric) cogs_month,
  COALESCE(cogs.known_total,0::numeric) known_cogs_month,
  COALESCE(cogs.pending_count,0) pending_cost_items_month,
  COALESCE(cogs.pending_revenue,0::numeric) pending_cost_revenue_month,
  COALESCE(cogs.pending_count,0)>0 has_pending_cost_month,
  CASE WHEN COALESCE(cogs.pending_count,0)=0 THEN COALESCE(sales.total_sales,0)
    -COALESCE(cogs.known_total,0)-COALESCE(expenses.total_expenses,0) END confirmed_result_month,
  COALESCE(losses.writeoff_total,0::numeric) credit_writeoff_month,
  COALESCE(losses.recovery_total,0::numeric) credit_recovery_month
FROM network.partner_units pu
JOIN network.partners p ON p.id=pu.partner_id AND p.environment=pu.environment
CROSS JOIN month_bounds mb
LEFT JOIN LATERAL (
  SELECT count(*)::int order_count,COALESCE(sum(o.total_amount),0) total_sales
    FROM commerce.partner_orders o
   WHERE o.environment=pu.environment AND o.unit_id=pu.unit_id
     AND o.status<>'cancelled' AND o.deleted_at IS NULL
     AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered')
     AND NOT o.awaiting_pickup
     AND (CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at
       ELSE COALESCE(o.retrieved_at,o.created_at) END)>=mb.month_start_at
) sales ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(i.quantity::numeric*i.unit_cost_snapshot)
      FILTER (WHERE i.cost_status='known'),0) known_total,
    count(*) FILTER (WHERE i.cost_status='pending')::int pending_count,
    COALESCE(sum(i.quantity::numeric*i.unit_price-i.discount_amount)
      FILTER (WHERE i.cost_status='pending'),0) pending_revenue
  FROM commerce.partner_orders o JOIN commerce.partner_order_items i
    ON i.environment=o.environment AND i.order_id=o.id
  WHERE o.environment=pu.environment AND o.unit_id=pu.unit_id
    AND o.status<>'cancelled' AND o.deleted_at IS NULL
    AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered')
    AND NOT o.awaiting_pickup
    AND (CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at
      ELSE COALESCE(o.retrieved_at,o.created_at) END)>=mb.month_start_at
) cogs ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(x.total_amount),0) total_purchases
  FROM commerce.partner_purchases x
  WHERE x.environment=pu.environment AND x.unit_id=pu.unit_id
    AND x.purchased_at>=mb.month_start_at AND x.deleted_at IS NULL
) purchases ON true
LEFT JOIN LATERAL (
  SELECT COALESCE((SELECT sum(e.amount) FROM finance.partner_expenses e
      WHERE e.environment=pu.environment AND e.unit_id=pu.unit_id
        AND e.deleted_at IS NULL AND e.source_payable_id IS NULL
        AND e.competence_month=mb.month_start_date),0)
    +COALESCE((SELECT sum(x.amount) FROM finance.partner_payables x
      WHERE x.environment=pu.environment AND x.unit_id=pu.unit_id
        AND x.deleted_at IS NULL AND x.source_purchase_id IS NULL
        AND x.status IN ('open','paid') AND x.competence_month=mb.month_start_date),0)
    +COALESCE((SELECT sum(e.commission_amount) FROM finance.partner_staff_commission_entries e
      WHERE e.environment=pu.environment AND e.unit_id=pu.unit_id
        AND e.status='earned' AND e.settlement_period_id IS NULL
        AND e.competence_month=mb.month_start_date),0)
    +COALESCE((SELECT sum(a.amount) FROM finance.partner_staff_commission_adjustments a
      WHERE a.environment=pu.environment AND a.unit_id=pu.unit_id
        AND a.settlement_period_id IS NULL AND a.competence_month=mb.month_start_date),0)
    +COALESCE((SELECT sum(CASE event_kind WHEN 'writeoff' THEN amount ELSE -amount END)
      FROM finance.partner_receivable_events e
      WHERE e.environment=pu.environment AND e.unit_id=pu.unit_id
        AND e.event_kind IN ('writeoff','recovery')
        AND e.occurred_at>=mb.month_start_at),0) total_expenses
) expenses ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(amount) FILTER (WHERE event_kind='writeoff'),0) writeoff_total,
    COALESCE(sum(amount) FILTER (WHERE event_kind='recovery'),0) recovery_total
  FROM finance.partner_receivable_events e
  WHERE e.environment=pu.environment AND e.unit_id=pu.unit_id
    AND e.occurred_at>=mb.month_start_at
) losses ON true
LEFT JOIN LATERAL (
  SELECT COALESCE((SELECT sum(o.total_amount) FROM commerce.partner_orders o
      WHERE o.environment=pu.environment AND o.unit_id=pu.unit_id
        AND (o.status<>'cancelled' OR EXISTS (SELECT 1
          FROM finance.partner_order_refunds refund
          WHERE refund.environment=o.environment AND refund.order_id=o.id))
        AND o.deleted_at IS NULL
        AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered')
        AND NOT o.awaiting_pickup
        AND (CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at
          ELSE COALESCE(o.retrieved_at,o.created_at) END)>=mb.month_start_at
        AND NOT EXISTS (SELECT 1 FROM finance.partner_receivables r
          WHERE r.environment=o.environment AND r.source_order_id=o.id
            AND r.deleted_at IS NULL)),0)
    +COALESCE((SELECT sum(e.amount) FROM finance.partner_receivable_events e
      WHERE e.environment=pu.environment AND e.unit_id=pu.unit_id
        AND e.event_kind IN ('receipt','recovery')
        AND e.occurred_at>=mb.month_start_at),0) total
) cash_in ON true
LEFT JOIN LATERAL (
  SELECT COALESCE((SELECT sum(x.total_amount) FROM commerce.partner_purchases x
      WHERE x.environment=pu.environment AND x.unit_id=pu.unit_id
        AND x.deleted_at IS NULL AND x.purchased_at>=mb.month_start_at
        AND x.payment_status='paid_now'
        AND NOT EXISTS (SELECT 1 FROM finance.partner_payables q
          WHERE q.environment=x.environment AND q.source_purchase_id=x.id
            AND q.deleted_at IS NULL)),0)
    +COALESCE((SELECT sum(e.amount) FROM finance.partner_expenses e
      WHERE e.environment=pu.environment AND e.unit_id=pu.unit_id
        AND e.deleted_at IS NULL AND e.expense_date>=mb.month_start_date
        AND e.source_payable_id IS NULL),0)
    +COALESCE((SELECT sum(e.amount) FROM finance.partner_payable_events e
      WHERE e.environment=pu.environment AND e.unit_id=pu.unit_id
        AND e.paid_at>=mb.month_start_at),0)
    +COALESCE((SELECT sum(e.amount) FROM finance.partner_receivable_events e
      WHERE e.environment=pu.environment AND e.unit_id=pu.unit_id
        AND e.event_kind='refund' AND e.occurred_at>=mb.month_start_at),0)
    +COALESCE((SELECT sum(r.amount) FROM finance.partner_order_refunds r
      WHERE r.environment=pu.environment AND r.unit_id=pu.unit_id
        AND r.refunded_at>=mb.month_start_at),0) total
) cash_out ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(open_amount),0) total FROM finance.partner_receivables_effective r
  WHERE r.environment=pu.environment AND r.unit_id=pu.unit_id AND r.open_amount>0
) open_recv ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(open_amount),0) total FROM finance.partner_payables_effective x
  WHERE x.environment=pu.environment AND x.unit_id=pu.unit_id AND x.open_amount>0
) open_pay ON true
LEFT JOIN LATERAL (
  SELECT count(*)::int stock_items,count(*) FILTER (WHERE stock_status IN
    ('low_stock','out_of_stock'))::int low_stock_items
  FROM commerce.partner_stock_levels s
  WHERE s.environment=pu.environment AND s.unit_id=pu.unit_id AND s.deleted_at IS NULL
) stock ON true
WHERE pu.deleted_at IS NULL;

GRANT SELECT ON network.partner_unit_summary TO farejador_partner_app;
COMMENT ON VIEW network.partner_unit_summary IS
  '0200: competencia separada de caixa; recebimentos e pagamentos por eventos imutaveis.';

-- Livro da Matriz: perda de credito resolve o contas a receber sem fingir que
-- houve entrada de caixa. O fato contabil e Dr perda / Cr contas a receber.
ALTER TABLE finance.matriz_ledger_payments
  DROP CONSTRAINT IF EXISTS matriz_ledger_payments_payment_kind_check;
ALTER TABLE finance.matriz_ledger_payments
  DROP CONSTRAINT IF EXISTS matriz_ledger_payments_kind_check;
ALTER TABLE finance.matriz_ledger_payments
  ADD CONSTRAINT matriz_ledger_payments_payment_kind_check
    CHECK (payment_kind IN ('settlement','writeoff','reversal'));
ALTER TABLE finance.matriz_ledger_payments
  ADD CONSTRAINT matriz_ledger_payments_kind_check CHECK (
    (payment_kind IN ('settlement','writeoff') AND reversal_of_payment_id IS NULL)
    OR (payment_kind='reversal' AND reversal_of_payment_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION finance.assert_matriz_ledger_payment()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_obligation finance.matriz_ledger_transactions%ROWTYPE;
  v_payment finance.matriz_ledger_transactions%ROWTYPE;
  v_original finance.matriz_ledger_payments%ROWTYPE;
  v_net NUMERIC(14,2);
BEGIN
  SELECT * INTO STRICT v_obligation FROM finance.matriz_ledger_transactions
   WHERE id=NEW.obligation_transaction_id;
  SELECT * INTO STRICT v_payment FROM finance.matriz_ledger_transactions
   WHERE id=NEW.payment_transaction_id;
  IF v_obligation.reversal_of_transaction_id IS NOT NULL
     OR v_obligation.transaction_kind IN ('payment','reversal')
     OR EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
       WHERE r.environment=NEW.environment
         AND r.reversal_of_transaction_id=v_obligation.id) THEN
    RAISE EXCEPTION 'matriz_ledger_invalid_obligation';
  END IF;
  IF NEW.amount<>v_payment.amount THEN
    RAISE EXCEPTION 'matriz_ledger_payment_amount_mismatch';
  END IF;
  IF NEW.payment_kind='settlement' THEN
    IF v_payment.transaction_kind<>'payment'
       OR v_payment.reversal_of_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_payment_transaction';
    END IF;
  ELSIF NEW.payment_kind='writeoff' THEN
    IF v_payment.transaction_kind<>'credit_writeoff'
       OR v_payment.reversal_of_transaction_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_entries e
         WHERE e.transaction_id=v_payment.id AND e.account_code='bad_debt_expense'
           AND e.account_class='expense' AND e.side='debit')
       OR NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_entries e
         WHERE e.transaction_id=v_payment.id AND e.account_code='accounts_receivable'
           AND e.account_class='asset' AND e.side='credit') THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_writeoff_transaction';
    END IF;
  ELSE
    SELECT * INTO STRICT v_original FROM finance.matriz_ledger_payments
     WHERE id=NEW.reversal_of_payment_id;
    IF v_original.payment_kind<>'settlement'
       OR v_original.obligation_transaction_id<>NEW.obligation_transaction_id
       OR v_original.amount<>NEW.amount
       OR v_payment.reversal_of_transaction_id<>v_original.payment_transaction_id THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_payment_reversal';
    END IF;
  END IF;
  SELECT COALESCE(sum(CASE WHEN p.payment_kind IN ('settlement','writeoff')
    THEN p.amount ELSE -p.amount END),0) INTO v_net
  FROM finance.matriz_ledger_payments p
  WHERE p.obligation_transaction_id=NEW.obligation_transaction_id;
  IF v_net<0 OR v_net>v_obligation.amount THEN
    RAISE EXCEPTION 'matriz_ledger_payment_out_of_bounds';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION finance.matriz_ledger_obligation_balance(
  p_environment env_t,p_obligation_transaction_id UUID
) RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,finance
AS $fn$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
      WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)
    THEN 0::numeric ELSE t.amount-COALESCE(sum(CASE
      WHEN p.payment_kind IN ('settlement','writeoff') THEN p.amount ELSE -p.amount END),0) END
  FROM finance.matriz_ledger_transactions t
  LEFT JOIN finance.matriz_ledger_payments p
    ON p.environment=t.environment AND p.obligation_transaction_id=t.id
  WHERE t.environment=p_environment AND t.id=p_obligation_transaction_id
  GROUP BY t.id,t.environment,t.amount
$fn$;

DO $smoke$
BEGIN
  IF to_regclass('finance.partner_receivable_events') IS NULL
     OR to_regclass('finance.partner_payable_events') IS NULL THEN
    RAISE EXCEPTION '0200: tabelas de eventos financeiros ausentes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='finance' AND table_name='partner_receivables_effective'
      AND column_name='open_amount') THEN
    RAISE EXCEPTION '0200: saldo efetivo de recebiveis ausente';
  END IF;
END
$smoke$;

INSERT INTO ops.application_schema_state(singleton,version,migration_name,applied_at)
VALUES (true,200,'0200_finance_credit_lifecycle.sql',now())
ON CONFLICT (singleton) DO UPDATE
SET version=EXCLUDED.version,
    migration_name=EXCLUDED.migration_name,
    applied_at=EXCLUDED.applied_at;
