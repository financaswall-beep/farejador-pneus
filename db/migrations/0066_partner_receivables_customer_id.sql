-- ============================================================
-- 0066_partner_receivables_customer_id.sql
-- Vincula contas a receber ao cadastro de clientes do parceiro.
--   - Adiciona customer_id em finance.partner_receivables com FK para
--     commerce.partner_customers(id) ON DELETE SET NULL (excluir cliente
--     nao apaga a conta a receber, apenas desvincula).
--   - customer_name continua existindo como rotulo livre / fallback.
-- ============================================================

ALTER TABLE finance.partner_receivables
  ADD COLUMN IF NOT EXISTS customer_id UUID
    REFERENCES commerce.partner_customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS partner_receivables_customer_idx
  ON finance.partner_receivables(environment, unit_id, customer_id)
  WHERE customer_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN finance.partner_receivables.customer_id IS
  'Cliente cadastrado vinculado a esta conta a receber. NULL quando lancamento avulso.';
