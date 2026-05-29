-- ============================================================
-- 0063_partner_customers_address_parts.sql
-- Endereco estruturado no cadastro de clientes do parceiro.
-- ============================================================

ALTER TABLE commerce.partner_customers
  ADD COLUMN IF NOT EXISTS address_street TEXT,
  ADD COLUMN IF NOT EXISTS address_neighborhood TEXT,
  ADD COLUMN IF NOT EXISTS address_city TEXT;

CREATE INDEX IF NOT EXISTS partner_customers_address_parts_idx
  ON commerce.partner_customers(environment, unit_id, lower(address_city), lower(address_neighborhood))
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN commerce.partner_customers.address_street IS
  'Rua/numero/complemento do cliente no cadastro do parceiro.';

COMMENT ON COLUMN commerce.partner_customers.address_neighborhood IS
  'Bairro do cliente no cadastro do parceiro.';

COMMENT ON COLUMN commerce.partner_customers.address_city IS
  'Municipio/cidade do cliente no cadastro do parceiro.';
