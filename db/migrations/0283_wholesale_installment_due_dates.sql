-- Correções operacionais por número da parcela. O plano original permanece na receita.
ALTER TABLE commerce.wholesale_orders
  ADD COLUMN installment_due_dates jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(installment_due_dates) = 'object');
