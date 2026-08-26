-- 0212_purchase_payable_adjustment.sql
-- A recusa parcial no recebimento reduz a obrigação com o fornecedor sem
-- fingir saída de caixa nem perda de crédito de cliente.

BEGIN;

ALTER TABLE finance.matriz_ledger_payments
  DROP CONSTRAINT IF EXISTS matriz_ledger_payments_payment_kind_check;
ALTER TABLE finance.matriz_ledger_payments
  DROP CONSTRAINT IF EXISTS matriz_ledger_payments_kind_check;
ALTER TABLE finance.matriz_ledger_payments
  ADD CONSTRAINT matriz_ledger_payments_payment_kind_check
    CHECK (payment_kind IN ('settlement','writeoff','adjustment','reversal')),
  ADD CONSTRAINT matriz_ledger_payments_kind_check CHECK (
    (payment_kind IN ('settlement','writeoff','adjustment')
      AND reversal_of_payment_id IS NULL)
    OR (payment_kind='reversal' AND reversal_of_payment_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION finance.assert_matriz_ledger_payment()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_obligation finance.matriz_ledger_transactions%ROWTYPE;
  v_payment finance.matriz_ledger_transactions%ROWTYPE;
  v_original finance.matriz_ledger_payments%ROWTYPE;
  v_net NUMERIC(14,2);
BEGIN
  SELECT * INTO STRICT v_obligation FROM finance.matriz_ledger_transactions
   WHERE id=NEW.obligation_transaction_id;
  SELECT * INTO STRICT v_payment FROM finance.matriz_ledger_transactions
   WHERE id=NEW.payment_transaction_id;
  IF v_obligation.environment<>NEW.environment OR v_payment.environment<>NEW.environment THEN
    RAISE EXCEPTION 'matriz_ledger_payment_environment_mismatch';
  END IF;
  IF v_obligation.reversal_of_transaction_id IS NOT NULL
     OR v_obligation.transaction_kind IN ('payment','reversal')
     OR EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
       WHERE r.environment=NEW.environment
         AND r.reversal_of_transaction_id=v_obligation.id) THEN
    RAISE EXCEPTION 'matriz_ledger_invalid_obligation';
  END IF;
  IF NEW.payment_kind='adjustment' THEN
    IF NEW.amount>v_payment.amount THEN
      RAISE EXCEPTION 'matriz_ledger_payment_amount_mismatch';
    END IF;
  ELSIF NEW.amount<>v_payment.amount THEN
    RAISE EXCEPTION 'matriz_ledger_payment_amount_mismatch';
  END IF;
  IF NEW.payment_kind='settlement' THEN
    IF v_payment.transaction_kind<>'payment'
       OR v_payment.reversal_of_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_payment_transaction';
    END IF;
  ELSIF NEW.payment_kind='writeoff' THEN
    IF v_payment.transaction_kind<>'credit_writeoff'
       OR v_payment.reversal_of_transaction_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_entries e
         WHERE e.transaction_id=v_payment.id AND e.account_code='bad_debt_expense'
           AND e.account_class='expense' AND e.side='debit')
       OR NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_entries e
         WHERE e.transaction_id=v_payment.id AND e.account_code='accounts_receivable'
           AND e.account_class='asset' AND e.side='credit') THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_writeoff_transaction';
    END IF;
  ELSIF NEW.payment_kind='adjustment' THEN
    IF v_obligation.source_type<>'commerce.wholesale_purchase.accrual'
       OR v_payment.source_type<>'commerce.wholesale_purchase.adjustment'
       OR v_obligation.source_id<>v_payment.source_id
       OR v_payment.transaction_kind<>'purchase_quantity_adjustment'
       OR v_payment.reversal_of_transaction_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_entries e
         WHERE e.transaction_id=v_payment.id AND e.account_code='accounts_payable'
           AND e.account_class='liability' AND e.side='debit'
           AND e.amount=NEW.amount) THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_adjustment_transaction';
    END IF;
  ELSE
    SELECT * INTO STRICT v_original FROM finance.matriz_ledger_payments
     WHERE id=NEW.reversal_of_payment_id;
    IF v_original.payment_kind<>'settlement'
       OR v_original.obligation_transaction_id<>NEW.obligation_transaction_id
       OR v_original.amount<>NEW.amount
       OR v_payment.reversal_of_transaction_id<>v_original.payment_transaction_id THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_payment_reversal';
    END IF;
  END IF;
  SELECT COALESCE(sum(CASE
    WHEN p.payment_kind IN ('settlement','writeoff','adjustment') THEN p.amount
    ELSE -p.amount END),0) INTO v_net
  FROM finance.matriz_ledger_payments p
  WHERE p.obligation_transaction_id=NEW.obligation_transaction_id;
  IF v_net<0 OR v_net>v_obligation.amount THEN
    RAISE EXCEPTION 'matriz_ledger_payment_out_of_bounds';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION finance.matriz_ledger_obligation_balance(
  p_environment env_t,p_obligation_transaction_id UUID
) RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,finance
AS $fn$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
      WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)
    THEN 0::numeric ELSE t.amount-COALESCE(sum(CASE
      WHEN p.payment_kind IN ('settlement','writeoff','adjustment') THEN p.amount
      ELSE -p.amount END),0) END
  FROM finance.matriz_ledger_transactions t
  LEFT JOIN finance.matriz_ledger_payments p
    ON p.environment=t.environment AND p.obligation_transaction_id=t.id
  WHERE t.environment=p_environment AND t.id=p_obligation_transaction_id
  GROUP BY t.id,t.environment,t.amount
$fn$;

COMMENT ON FUNCTION finance.matriz_ledger_obligation_balance(env_t,UUID) IS
  '0212: saldo da obrigação considera pagamento, perda de crédito e ajuste comercial de compra como fatos distintos.';

DO $smoke$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='finance' AND t.relname='matriz_ledger_payments'
      AND c.conname='matriz_ledger_payments_payment_kind_check'
      AND pg_get_constraintdef(c.oid) LIKE '%adjustment%'
  ) THEN
    RAISE EXCEPTION '0212: payment_kind adjustment não foi instalado';
  END IF;
END;
$smoke$;

COMMIT;
