-- 0169 - Recebimento de compras pela Operacao da Loja.
--
-- Compras existentes ja movimentaram estoque e sao preservadas como recebidas.
-- Compras novas nascem pendentes no codigo da aplicacao; somente a confirmacao
-- do funcionario grava a quantidade recebida e incrementa o estoque.

ALTER TABLE commerce.partner_purchases
  ADD COLUMN IF NOT EXISTS receipt_status TEXT,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS received_by_token_id UUID
    REFERENCES network.partner_access_tokens(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS received_by_label TEXT,
  ADD COLUMN IF NOT EXISTS receipt_idempotency_key TEXT;

UPDATE commerce.partner_purchases
   SET receipt_status = 'received',
       received_at = COALESCE(received_at, purchased_at, created_at)
 WHERE receipt_status IS NULL;

ALTER TABLE commerce.partner_purchases
  ALTER COLUMN receipt_status SET DEFAULT 'received',
  ALTER COLUMN receipt_status SET NOT NULL;

ALTER TABLE commerce.partner_purchases
  DROP CONSTRAINT IF EXISTS partner_purchases_receipt_status_check;
ALTER TABLE commerce.partner_purchases
  ADD CONSTRAINT partner_purchases_receipt_status_check
  CHECK (receipt_status IN ('pending', 'received'));

CREATE INDEX IF NOT EXISTS partner_purchases_pending_receipt_idx
  ON commerce.partner_purchases(environment, unit_id, created_at)
  WHERE receipt_status = 'pending' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS partner_purchases_receipt_idempotency_uniq
  ON commerce.partner_purchases(environment, unit_id, receipt_idempotency_key)
  WHERE receipt_idempotency_key IS NOT NULL;

ALTER TABLE commerce.partner_purchase_items
  ADD COLUMN IF NOT EXISTS tire_size TEXT,
  ADD COLUMN IF NOT EXISTS tire_width_mm INTEGER,
  ADD COLUMN IF NOT EXISTS tire_aspect_ratio INTEGER,
  ADD COLUMN IF NOT EXISTS tire_rim_diameter INTEGER,
  ADD COLUMN IF NOT EXISTS brand TEXT,
  ADD COLUMN IF NOT EXISTS sale_price NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS received_quantity INTEGER;

UPDATE commerce.partner_purchase_items item
   SET received_quantity = item.quantity
  FROM commerce.partner_purchases purchase
 WHERE purchase.id = item.purchase_id
   AND purchase.environment = item.environment
   AND purchase.receipt_status = 'received'
   AND item.received_quantity IS NULL;

ALTER TABLE commerce.partner_purchase_items
  DROP CONSTRAINT IF EXISTS partner_purchase_items_received_quantity_check;
ALTER TABLE commerce.partner_purchase_items
  ADD CONSTRAINT partner_purchase_items_received_quantity_check
  CHECK (received_quantity IS NULL OR received_quantity >= 0);

COMMENT ON COLUMN commerce.partner_purchases.receipt_status IS
  '0169: pending ate a equipe conferir; received depois da entrada transacional no estoque.';
COMMENT ON COLUMN commerce.partner_purchases.receipt_idempotency_key IS
  '0169: impede que repetir a confirmacao duplique a entrada no estoque.';
COMMENT ON COLUMN commerce.partner_purchase_items.received_quantity IS
  '0169: quantidade fisica confirmada no recebimento; NULL enquanto pendente.';

DO $smoke$
BEGIN
  IF EXISTS (
    SELECT 1 FROM commerce.partner_purchases
     WHERE receipt_status IS NULL
  ) THEN
    RAISE EXCEPTION '0169: compra sem receipt_status';
  END IF;
  IF to_regclass('commerce.partner_purchases_pending_receipt_idx') IS NULL THEN
    RAISE EXCEPTION '0169: indice de recebimentos pendentes ausente';
  END IF;
  IF to_regclass('commerce.partner_purchases_receipt_idempotency_uniq') IS NULL THEN
    RAISE EXCEPTION '0169: indice de idempotencia do recebimento ausente';
  END IF;
END;
$smoke$;
