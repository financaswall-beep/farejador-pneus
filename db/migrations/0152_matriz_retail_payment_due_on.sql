-- 0152 - Vencimento explicito da venda a receber no varejo da Matriz.
-- Aditiva: linhas historicas permanecem validas; novas rotas exigem a data.

ALTER TABLE commerce.orders
  ADD COLUMN IF NOT EXISTS payment_due_on DATE;

COMMENT ON COLUMN commerce.orders.payment_due_on IS
  'Vencimento financeiro quando payment_method = A receber. Nao e data de entrega.';

CREATE INDEX IF NOT EXISTS orders_matriz_receivable_due_idx
  ON commerce.orders(environment,payment_due_on)
  WHERE lower(btrim(COALESCE(payment_method,'')))='a receber'
    AND status<>'cancelled';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='commerce' AND table_name='orders'
       AND column_name='payment_due_on'
  ) THEN
    RAISE EXCEPTION '0152 falhou: commerce.orders.payment_due_on ausente';
  END IF;
END;
$check$;
