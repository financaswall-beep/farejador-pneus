-- 0146 - Estorno causal de comissao preserva receita/caixa historicos.
-- Toda comissao estornada ganha um fato de reversao. Se a comissao ja havia
-- sido recebida, nasce tambem uma obrigacao de devolucao para a Matriz.

CREATE TABLE finance.matriz_commission_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  commission_entry_id UUID NOT NULL
    REFERENCES network.commission_entries(id),
  partner_id UUID NOT NULL,
  partner_order_id UUID NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reversed_at TIMESTAMPTZ NOT NULL,
  original_settled_at TIMESTAMPTZ,
  refund_status TEXT NOT NULL CHECK (refund_status IN ('not_due','pending','paid')),
  refund_due_date DATE,
  refunded_at TIMESTAMPTZ,
  refunded_by TEXT,
  refund_operation_key TEXT,
  refund_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT matriz_commission_reversals_source_uniq
    UNIQUE (environment,commission_entry_id),
  CONSTRAINT matriz_commission_reversals_refund_state_check CHECK (
    (refund_status='not_due'
      AND original_settled_at IS NULL
      AND refund_due_date IS NULL
      AND refunded_at IS NULL
      AND refunded_by IS NULL
      AND refund_operation_key IS NULL
      AND refund_reason IS NULL)
    OR
    (refund_status='pending'
      AND original_settled_at IS NOT NULL
      AND refund_due_date IS NOT NULL
      AND refunded_at IS NULL
      AND refunded_by IS NULL
      AND refund_operation_key IS NULL
      AND refund_reason IS NULL)
    OR
    (refund_status='paid'
      AND original_settled_at IS NOT NULL
      AND refund_due_date IS NOT NULL
      AND refunded_at IS NOT NULL
      AND refunded_at>=reversed_at
      AND length(btrim(refunded_by)) BETWEEN 2 AND 200
      AND length(refund_operation_key) BETWEEN 8 AND 200
      AND length(btrim(refund_reason)) BETWEEN 2 AND 500)
  )
);

CREATE INDEX matriz_commission_reversals_pending_idx
  ON finance.matriz_commission_reversals(environment,refund_due_date,reversed_at)
  WHERE refund_status='pending';
CREATE UNIQUE INDEX matriz_commission_reversals_refund_operation_uniq
  ON finance.matriz_commission_reversals(environment,refund_operation_key)
  WHERE refund_operation_key IS NOT NULL;

CREATE TRIGGER env_match_matriz_commission_reversal_entry
  BEFORE INSERT OR UPDATE OF commission_entry_id
  ON finance.matriz_commission_reversals
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','commission_entries','commission_entry_id');
CREATE TRIGGER env_match_matriz_commission_reversal_partner
  BEFORE INSERT OR UPDATE OF partner_id
  ON finance.matriz_commission_reversals
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'network','partners','partner_id');

CREATE OR REPLACE FUNCTION finance.guard_matriz_commission_reversal()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'commission_reversal_immutable';
  END IF;
  IF OLD.refund_status='pending'
     AND NEW.refund_status='paid'
     AND NEW.refunded_at IS NOT NULL
     AND length(btrim(NEW.refunded_by)) BETWEEN 2 AND 200
     AND length(NEW.refund_operation_key) BETWEEN 8 AND 200
     AND length(btrim(NEW.refund_reason)) BETWEEN 2 AND 500
     AND NEW.environment IS NOT DISTINCT FROM OLD.environment
     AND NEW.commission_entry_id IS NOT DISTINCT FROM OLD.commission_entry_id
     AND NEW.partner_id IS NOT DISTINCT FROM OLD.partner_id
     AND NEW.partner_order_id IS NOT DISTINCT FROM OLD.partner_order_id
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.reversed_at IS NOT DISTINCT FROM OLD.reversed_at
     AND NEW.original_settled_at IS NOT DISTINCT FROM OLD.original_settled_at
     AND NEW.refund_due_date IS NOT DISTINCT FROM OLD.refund_due_date
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'commission_reversal_immutable';
END
$fn$;

CREATE TRIGGER matriz_commission_reversal_immutable
  BEFORE UPDATE OR DELETE ON finance.matriz_commission_reversals
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_commission_reversal();

CREATE OR REPLACE FUNCTION finance.record_matriz_commission_reversal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance
AS $fn$
DECLARE
  v_reversed_at TIMESTAMPTZ := COALESCE(NEW.reversed_at,now());
BEGIN
  IF NEW.status='reversed'
     AND OLD.status<>'reversed'
     AND NEW.commission_amount>0 THEN
    INSERT INTO finance.matriz_commission_reversals
      (environment,commission_entry_id,partner_id,partner_order_id,amount,
       reversed_at,original_settled_at,refund_status,refund_due_date)
    VALUES
      (NEW.environment::public.env_t,NEW.id,NEW.partner_id,NEW.partner_order_id,
       NEW.commission_amount,v_reversed_at,NEW.settled_at,
       CASE WHEN NEW.settled_at IS NULL THEN 'not_due' ELSE 'pending' END,
       CASE WHEN NEW.settled_at IS NULL THEN NULL
         ELSE (v_reversed_at AT TIME ZONE 'America/Sao_Paulo')::date END)
    ON CONFLICT (environment,commission_entry_id) DO NOTHING;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER record_matriz_commission_reversal
  AFTER UPDATE OF status ON network.commission_entries
  FOR EACH ROW EXECUTE FUNCTION finance.record_matriz_commission_reversal();

-- Preserva e torna explicito o legado. Comissao estornada antes de receber nao
-- gera divida de caixa; comissao ja recebida vira devolucao pendente.
INSERT INTO finance.matriz_commission_reversals
  (environment,commission_entry_id,partner_id,partner_order_id,amount,
   reversed_at,original_settled_at,refund_status,refund_due_date)
SELECT ce.environment::env_t,ce.id,ce.partner_id,ce.partner_order_id,
       ce.commission_amount,COALESCE(ce.reversed_at,ce.created_at),
       ce.settled_at,
       CASE WHEN ce.settled_at IS NULL THEN 'not_due' ELSE 'pending' END,
       CASE WHEN ce.settled_at IS NULL THEN NULL
         ELSE (COALESCE(ce.reversed_at,ce.created_at)
           AT TIME ZONE 'America/Sao_Paulo')::date END
  FROM network.commission_entries ce
 WHERE ce.status='reversed' AND ce.commission_amount>0
ON CONFLICT (environment,commission_entry_id) DO NOTHING;

REVOKE ALL ON finance.matriz_commission_reversals FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.record_matriz_commission_reversal() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_matriz_commission_reversal() FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON finance.matriz_commission_reversals FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.record_matriz_commission_reversal()
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.guard_matriz_commission_reversal()
      FROM farejador_partner_app;
  END IF;
END
$security$;

COMMENT ON TABLE finance.matriz_commission_reversals IS
  '0146: reversao por competencia e eventual devolucao de caixa de comissao 2W; append-only salvo liquidacao pending->paid.';
