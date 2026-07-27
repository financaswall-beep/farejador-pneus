-- 0151 - Mensalidade deixa de ser somente configuracao na ficha do parceiro.
-- Cada competencia gera um recebivel imutavel com valor congelado.

CREATE TABLE finance.matriz_partner_monthly_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  partner_id UUID NOT NULL,
  competence DATE NOT NULL
    CHECK (competence=date_trunc('month',competence)::date),
  amount NUMERIC(12,2) NOT NULL CHECK (amount>0),
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  settled_at TIMESTAMPTZ,
  settled_by TEXT,
  settlement_operation_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT matriz_partner_monthly_fees_source_uniq
    UNIQUE (environment,partner_id,competence),
  CONSTRAINT matriz_partner_monthly_fees_environment_id_uniq
    UNIQUE (environment,id),
  CONSTRAINT matriz_partner_monthly_fees_partner_fk
    FOREIGN KEY (environment,partner_id)
    REFERENCES network.partners(environment,id),
  CONSTRAINT matriz_partner_monthly_fees_status_check CHECK (
    status IN ('open','settled') AND (
    (status='open' AND settled_at IS NULL AND settled_by IS NULL
      AND settlement_operation_key IS NULL)
    OR
    (status='settled' AND settled_at IS NOT NULL
      AND length(btrim(settled_by)) BETWEEN 2 AND 200
      AND length(settlement_operation_key) BETWEEN 8 AND 200)
    ))
);

CREATE INDEX matriz_partner_monthly_fees_open_idx
  ON finance.matriz_partner_monthly_fees(environment,due_date,partner_id)
  WHERE status='open';

CREATE OR REPLACE FUNCTION finance.guard_matriz_partner_monthly_fee()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'monthly_fee_immutable'; END IF;
  IF OLD.status='open' AND NEW.status='settled'
     AND NEW.environment IS NOT DISTINCT FROM OLD.environment
     AND NEW.partner_id IS NOT DISTINCT FROM OLD.partner_id
     AND NEW.competence IS NOT DISTINCT FROM OLD.competence
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.due_date IS NOT DISTINCT FROM OLD.due_date
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'monthly_fee_immutable';
END
$fn$;

CREATE TRIGGER matriz_partner_monthly_fee_immutable
  BEFORE UPDATE OR DELETE ON finance.matriz_partner_monthly_fees
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_partner_monthly_fee();

REVOKE ALL ON finance.matriz_partner_monthly_fees FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_matriz_partner_monthly_fee() FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON finance.matriz_partner_monthly_fees FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.guard_matriz_partner_monthly_fee()
      FROM farejador_partner_app;
  END IF;
END
$security$;

COMMENT ON TABLE finance.matriz_partner_monthly_fees IS
  '0151: recebivel mensal da Rede por parceiro e competencia; valor congelado da ficha, sem recomputar o passado.';
