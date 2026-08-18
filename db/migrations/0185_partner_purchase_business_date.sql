-- 0185 - Datas de compra são escolhidas por dia no painel, sem campo de horário.
-- Meio-dia do dia corrente não pode ser confundido com um dia futuro.

CREATE OR REPLACE FUNCTION commerce.guard_partner_purchase_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date
     > (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'partner_purchased_at_future' USING ERRCODE='23514';
  END IF;
  IF NEW.payment_status='payable' AND NEW.payable_due_date IS NOT NULL
     AND NEW.payable_due_date<(NEW.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'partner_payable_due_before_purchase' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

DO $smoke$
DECLARE
  v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('commerce.guard_partner_purchase_dates()'::regprocedure)
    INTO v_definition;
  IF v_definition NOT LIKE '%AT TIME ZONE ''America/Sao_Paulo''%'
     OR v_definition LIKE '%interval ''5 minutes''%' THEN
    RAISE EXCEPTION '0185: guarda ainda compara horario em vez do dia comercial';
  END IF;
END;
$smoke$;
