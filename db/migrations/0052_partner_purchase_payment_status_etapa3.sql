-- ============================================================
-- 0052_partner_purchase_payment_status_etapa3.sql
-- Etapa 3 dos consertos de conciliacao do financeiro do Portal Parceiro.
--
-- Compra de fornecedor a prazo:
--   - commerce.partner_purchases ganha payment_status ('paid_now' | 'payable')
--   - commerce.partner_purchases ganha payable_due_date DATE
--   - Quando payment_status='payable', a aplicacao (queries.ts) cria
--     finance.partner_payable correspondente com source_purchase_id preenchido
--     (FK criada na Etapa 2).
--   - Quando paga via settlePayable, NAO cria expense (porque a compra ja
--     foi contabilizada como saida no momento da compra). Essa logica vive
--     em queries.ts pra nao tocar na view de resumo nesta etapa - a Etapa 4
--     reescreve o resumo separando competencia vs caixa.
--
-- Default = 'paid_now' preserva comportamento atual (toda compra existente
-- conta como paga na hora).
--
-- Assinatura: Claude (Opus 4.7), 2026-05-24
-- ============================================================

ALTER TABLE commerce.partner_purchases
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid_now';

ALTER TABLE commerce.partner_purchases
  ADD COLUMN IF NOT EXISTS payable_due_date DATE;

-- Backfill defensivo (NOT NULL DEFAULT ja preenche, mas garante)
UPDATE commerce.partner_purchases
SET payment_status = 'paid_now'
WHERE payment_status IS NULL;

ALTER TABLE commerce.partner_purchases
  DROP CONSTRAINT IF EXISTS partner_purchases_payment_status_check;

ALTER TABLE commerce.partner_purchases
  ADD CONSTRAINT partner_purchases_payment_status_check
  CHECK (payment_status IN ('paid_now', 'payable'));

-- payable_due_date obrigatoria quando payment_status='payable'
ALTER TABLE commerce.partner_purchases
  DROP CONSTRAINT IF EXISTS partner_purchases_payable_due_date_check;

ALTER TABLE commerce.partner_purchases
  ADD CONSTRAINT partner_purchases_payable_due_date_check
  CHECK (
    payment_status = 'paid_now'
    OR (payment_status = 'payable' AND payable_due_date IS NOT NULL)
  );

COMMENT ON COLUMN commerce.partner_purchases.payment_status IS
  'Como a compra foi paga: paid_now (a vista, default) ou payable (a prazo - cria partner_payable em finance.* via aplicacao).';

COMMENT ON COLUMN commerce.partner_purchases.payable_due_date IS
  'Data de vencimento da compra a prazo. Obrigatoria quando payment_status=payable (CHECK).';
