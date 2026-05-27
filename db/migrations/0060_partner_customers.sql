-- ============================================================
-- 0060_partner_customers.sql
-- Cadastro MVP de clientes por unidade parceira.
-- ============================================================

CREATE TABLE IF NOT EXISTS commerce.partner_customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     env_t NOT NULL,
  unit_id         UUID NOT NULL REFERENCES core.units(id),
  name            TEXT NOT NULL,
  phone           TEXT,
  cpf             TEXT,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_customers_phone_uniq
  ON commerce.partner_customers(environment, unit_id, phone)
  WHERE phone IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS partner_customers_cpf_uniq
  ON commerce.partner_customers(environment, unit_id, cpf)
  WHERE cpf IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS partner_customers_idempotency_key_uniq
  ON commerce.partner_customers(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_customers_search_idx
  ON commerce.partner_customers(environment, unit_id, lower(name), phone, cpf)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS partner_customers_set_updated_at ON commerce.partner_customers;
CREATE TRIGGER partner_customers_set_updated_at
  BEFORE UPDATE ON commerce.partner_customers
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS env_match_partner_customers_unit ON commerce.partner_customers;
CREATE TRIGGER env_match_partner_customers_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON commerce.partner_customers
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

ALTER TABLE commerce.partner_customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_customers_isolation ON commerce.partner_customers;
CREATE POLICY partner_customers_isolation ON commerce.partner_customers
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  );

GRANT SELECT, INSERT, UPDATE ON commerce.partner_customers TO farejador_partner_app;

COMMENT ON TABLE commerce.partner_customers IS
  'Cadastro MVP de clientes da unidade parceira. Nao usa core.contacts nem Chatwoot.';
