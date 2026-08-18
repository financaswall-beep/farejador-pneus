-- 0186 - Uma unica regra de dia comercial para fatos financeiros.
-- Fatos realizados nao podem estar em dia futuro. Vencimentos continuam livres
-- para representar fiado, contas a pagar/receber e parcelas futuras.

CREATE OR REPLACE FUNCTION ops.guard_not_future_business_timestamps()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_column TEXT;
  v_value TEXT;
  v_today DATE := (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  FOREACH v_column IN ARRAY TG_ARGV LOOP
    v_value := to_jsonb(NEW) ->> v_column;
    IF v_value IS NOT NULL
       AND (v_value::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date > v_today THEN
      RAISE EXCEPTION '%_future', v_column USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION ops.guard_not_future_business_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_column TEXT;
  v_value TEXT;
  v_today DATE := (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  FOREACH v_column IN ARRAY TG_ARGV LOOP
    v_value := to_jsonb(NEW) ->> v_column;
    IF v_value IS NOT NULL AND v_value::date > v_today THEN
      RAISE EXCEPTION '%_future', v_column USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS matriz_expenses_business_timestamps_guard ON commerce.matriz_expenses;
CREATE TRIGGER matriz_expenses_business_timestamps_guard
BEFORE INSERT OR UPDATE OF occurred_at,paid_at ON commerce.matriz_expenses
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('occurred_at','paid_at');

DROP TRIGGER IF EXISTS matriz_expenses_business_dates_guard ON commerce.matriz_expenses;
CREATE TRIGGER matriz_expenses_business_dates_guard
BEFORE INSERT OR UPDATE OF document_date,competence_month ON commerce.matriz_expenses
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_dates('document_date','competence_month');

DROP TRIGGER IF EXISTS partner_expenses_business_dates_guard ON finance.partner_expenses;
CREATE TRIGGER partner_expenses_business_dates_guard
BEFORE INSERT OR UPDATE OF expense_date ON finance.partner_expenses
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_dates('expense_date');

DROP TRIGGER IF EXISTS partner_payables_business_time_guard ON finance.partner_payables;
CREATE TRIGGER partner_payables_business_time_guard
BEFORE INSERT OR UPDATE OF paid_at ON finance.partner_payables
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('paid_at');

DROP TRIGGER IF EXISTS partner_receivables_business_time_guard ON finance.partner_receivables;
CREATE TRIGGER partner_receivables_business_time_guard
BEFORE INSERT OR UPDATE OF received_at ON finance.partner_receivables
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('received_at');

DROP TRIGGER IF EXISTS partner_installments_business_time_guard ON finance.partner_receivable_installments;
CREATE TRIGGER partner_installments_business_time_guard
BEFORE INSERT OR UPDATE OF received_at ON finance.partner_receivable_installments
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('received_at');

DROP TRIGGER IF EXISTS commission_entries_business_time_guard ON network.commission_entries;
CREATE TRIGGER commission_entries_business_time_guard
BEFORE INSERT OR UPDATE OF settled_at ON network.commission_entries
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('settled_at');

DROP TRIGGER IF EXISTS matriz_monthly_fees_business_time_guard ON finance.matriz_partner_monthly_fees;
CREATE TRIGGER matriz_monthly_fees_business_time_guard
BEFORE INSERT OR UPDATE OF settled_at ON finance.matriz_partner_monthly_fees
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('settled_at');

DROP TRIGGER IF EXISTS matriz_commission_refunds_business_time_guard ON finance.matriz_commission_reversals;
CREATE TRIGGER matriz_commission_refunds_business_time_guard
BEFORE INSERT OR UPDATE OF refunded_at ON finance.matriz_commission_reversals
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('refunded_at');

DROP TRIGGER IF EXISTS matriz_payroll_business_time_guard ON finance.matriz_payroll_items;
CREATE TRIGGER matriz_payroll_business_time_guard
BEFORE INSERT OR UPDATE OF paid_at ON finance.matriz_payroll_items
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('paid_at');

DROP TRIGGER IF EXISTS matriz_ledger_payments_business_time_guard ON finance.matriz_ledger_payments;
CREATE TRIGGER matriz_ledger_payments_business_time_guard
BEFORE INSERT ON finance.matriz_ledger_payments
FOR EACH ROW EXECUTE FUNCTION ops.guard_not_future_business_timestamps('paid_at');

DO $smoke$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_trigger
   WHERE tgname IN (
     'matriz_expenses_business_timestamps_guard',
     'matriz_expenses_business_dates_guard',
     'partner_expenses_business_dates_guard',
     'partner_payables_business_time_guard',
     'partner_receivables_business_time_guard',
     'partner_installments_business_time_guard',
     'commission_entries_business_time_guard',
     'matriz_monthly_fees_business_time_guard',
     'matriz_commission_refunds_business_time_guard',
     'matriz_payroll_business_time_guard',
     'matriz_ledger_payments_business_time_guard'
   ) AND NOT tgisinternal;
  IF v_count <> 11 THEN
    RAISE EXCEPTION '0186: esperado 11 guards de data, encontrado %', v_count;
  END IF;
END;
$smoke$;
