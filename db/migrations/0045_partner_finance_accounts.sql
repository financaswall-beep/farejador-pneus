-- ============================================================
-- 0045_partner_finance_accounts.sql
-- Contas a pagar e contas a receber por unidade parceira.
--
-- Escopo:
--   - Tabelas transacionais simples em finance.*
--   - Isolamento por environment + unit_id
--   - RLS estrita usando network.current_partner_core_unit()
--   - GRANTs para a role restrita do Portal Parceiro
--
-- Nao substitui compras/despesas/vendas existentes. Serve para o parceiro
-- cadastrar compromissos financeiros em aberto.
-- ============================================================

CREATE TABLE IF NOT EXISTS finance.partner_payables (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  unit_id         UUID NOT NULL REFERENCES core.units(id),
  counterparty_name TEXT,
  description     TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('supplier', 'employee', 'rent', 'utilities', 'tax', 'maintenance', 'other')),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  due_date        DATE,
  status          TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'paid', 'cancelled')),
  paid_at         TIMESTAMPTZ,
  payment_method  TEXT,
  notes           TEXT,
  idempotency_key TEXT,
  created_by      TEXT,
  deleted_at      TIMESTAMPTZ,
  deleted_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.partner_receivables (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  unit_id         UUID NOT NULL REFERENCES core.units(id),
  customer_name   TEXT,
  description     TEXT NOT NULL,
  source_tag      TEXT DEFAULT 'porta'
    CHECK (source_tag IS NULL OR source_tag IN ('porta', '2w', 'walkin_balcao', 'walkin_telefone', 'outro')),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  due_date        DATE,
  status          TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'received', 'cancelled')),
  received_at     TIMESTAMPTZ,
  payment_method  TEXT,
  notes           TEXT,
  idempotency_key TEXT,
  created_by      TEXT,
  deleted_at      TIMESTAMPTZ,
  deleted_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_payables_unit_status_due_idx
  ON finance.partner_payables(environment, unit_id, status, due_date DESC NULLS LAST)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS partner_receivables_unit_status_due_idx
  ON finance.partner_receivables(environment, unit_id, status, due_date DESC NULLS LAST)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS partner_payables_idempotency_key_uniq
  ON finance.partner_payables(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS partner_receivables_idempotency_key_uniq
  ON finance.partner_receivables(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP TRIGGER IF EXISTS partner_payables_set_updated_at ON finance.partner_payables;
CREATE TRIGGER partner_payables_set_updated_at
  BEFORE UPDATE ON finance.partner_payables
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS partner_receivables_set_updated_at ON finance.partner_receivables;
CREATE TRIGGER partner_receivables_set_updated_at
  BEFORE UPDATE ON finance.partner_receivables
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS env_match_partner_payables_unit ON finance.partner_payables;
CREATE TRIGGER env_match_partner_payables_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON finance.partner_payables
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

DROP TRIGGER IF EXISTS env_match_partner_receivables_unit ON finance.partner_receivables;
CREATE TRIGGER env_match_partner_receivables_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON finance.partner_receivables
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

ALTER TABLE finance.partner_payables ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.partner_receivables ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_payables_isolation ON finance.partner_payables;
CREATE POLICY partner_payables_isolation ON finance.partner_payables
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  );

DROP POLICY IF EXISTS partner_receivables_isolation ON finance.partner_receivables;
CREATE POLICY partner_receivables_isolation ON finance.partner_receivables
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  );

GRANT SELECT, INSERT, UPDATE ON finance.partner_payables TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON finance.partner_receivables TO farejador_partner_app;

COMMENT ON TABLE finance.partner_payables IS
  'Contas a pagar cadastradas pela unidade parceira. Escopo: parceiro, nao matriz.';

COMMENT ON TABLE finance.partner_receivables IS
  'Contas a receber cadastradas pela unidade parceira. Escopo: parceiro, nao matriz.';
