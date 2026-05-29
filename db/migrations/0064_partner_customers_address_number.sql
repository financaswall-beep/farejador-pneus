-- ============================================================
-- 0064_partner_customers_address_number.sql
-- Numero do endereco em campo separado no cadastro de clientes.
-- ============================================================

ALTER TABLE commerce.partner_customers
  ADD COLUMN IF NOT EXISTS address_number TEXT;

COMMENT ON COLUMN commerce.partner_customers.address_number IS
  'Numero do endereco do cliente no cadastro do parceiro.';
