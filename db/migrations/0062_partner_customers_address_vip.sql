-- ============================================================
-- 0062_partner_customers_address_vip.sql
-- Complementa o cadastro MVP de clientes do parceiro.
-- ============================================================

ALTER TABLE commerce.partner_customers
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS is_vip BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS partner_customers_vip_idx
  ON commerce.partner_customers(environment, unit_id, is_vip, updated_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN commerce.partner_customers.address IS
  'Endereco livre do cliente no cadastro do parceiro. Nao usa core.contacts.';

COMMENT ON COLUMN commerce.partner_customers.is_vip IS
  'Marcador manual de cliente VIP da unidade parceira.';
