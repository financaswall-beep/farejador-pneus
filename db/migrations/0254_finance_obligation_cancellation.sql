-- 0254: composição de baixas e serialização de cancelamentos/recebimentos.
-- Não altera lançamentos existentes; exige implantação do código correspondente.
BEGIN;

CREATE FUNCTION finance.matriz_ledger_obligation_cancelled(p_environment env_t,p_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=pg_catalog,finance AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM finance.matriz_ledger_transactions t
    JOIN finance.matriz_ledger_transactions c ON c.environment=t.environment
    WHERE t.environment=p_environment AND t.id=p_id
      AND (c.reversal_of_transaction_id=t.id OR (c.source_id=t.source_id AND
        ((t.source_type='commerce.order.revenue' AND c.source_type='commerce.order.revenue_cancel')
        OR (t.source_type IN ('commerce.wholesale_order.revenue','commerce.wholesale_order.arrival_revenue')
          AND c.source_type='commerce.wholesale_order.revenue_cancel')
        OR (t.source_type='commerce.wholesale_purchase.accrual'
          AND c.source_type='commerce.wholesale_purchase.cancel'))))
  )
$fn$;

CREATE FUNCTION finance.matriz_ledger_obligation_breakdown(p_environment env_t,p_id UUID)
RETURNS TABLE(amount NUMERIC,cash_paid NUMERIC,written_off NUMERIC,adjusted NUMERIC,
  open_amount NUMERIC,reversed BOOLEAN)
LANGUAGE sql STABLE SET search_path=pg_catalog,finance AS $fn$
 SELECT t.amount,
   CASE WHEN t.transaction_kind IN ('sale_cash','purchase_cash') THEN t.amount ELSE
     COALESCE(sum(p.amount) FILTER (WHERE p.payment_kind='settlement'),0)
     -COALESCE(sum(p.amount) FILTER (WHERE p.payment_kind='reversal'),0) END,
   COALESCE(sum(p.amount) FILTER (WHERE p.payment_kind='writeoff'),0),
   COALESCE(sum(p.amount) FILTER (WHERE p.payment_kind='adjustment'),0),
   CASE WHEN t.transaction_kind IN ('sale_cash','purchase_cash') THEN 0::numeric ELSE
     finance.matriz_ledger_obligation_balance(p_environment,t.id) END,
   EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
     WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)
 FROM finance.matriz_ledger_transactions t
 LEFT JOIN finance.matriz_ledger_payments p
   ON p.environment=t.environment AND p.obligation_transaction_id=t.id
 WHERE t.environment=p_environment AND t.id=p_id
 GROUP BY t.id,t.environment,t.amount,t.transaction_kind
$fn$;

-- Antes de aceitar qualquer baixa, aguarda o cancelamento concorrente e relê.
CREATE FUNCTION finance.guard_matriz_obligation_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finance AS $fn$
BEGIN
  PERFORM id FROM finance.matriz_ledger_transactions
    WHERE environment=NEW.environment AND id=NEW.obligation_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'matriz_ledger_obligation_not_found'; END IF;
  IF NEW.payment_kind<>'reversal' AND
     finance.matriz_ledger_obligation_cancelled(NEW.environment,NEW.obligation_transaction_id) THEN
    RAISE EXCEPTION 'matriz_ledger_invalid_obligation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER matriz_obligation_payment_open BEFORE INSERT ON finance.matriz_ledger_payments
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_obligation_payment();

CREATE OR REPLACE FUNCTION finance.reverse_matriz_ledger_transaction(
  p_environment env_t,
  p_original_transaction_id UUID,
  p_source_type TEXT,
  p_source_id TEXT,
  p_competence_on DATE,
  p_description TEXT,
  p_created_by TEXT,
  p_cash_on DATE DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance
AS $fn$
DECLARE
  v_original finance.matriz_ledger_transactions%ROWTYPE;
  v_existing finance.matriz_ledger_transactions%ROWTYPE;
  v_entries JSONB;
  v_id UUID;
  v_fingerprint TEXT;
BEGIN
  SELECT * INTO v_original
    FROM finance.matriz_ledger_transactions
   WHERE environment=p_environment AND id=p_original_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'matriz_ledger_original_not_found'; END IF;
  IF v_original.reversal_of_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'matriz_ledger_reversal_of_reversal_forbidden';
  END IF;
  IF p_source_type !~ '^[a-z][a-z0-9_.-]{2,119}$'
     OR length(btrim(p_source_id)) NOT BETWEEN 1 AND 200
     OR p_competence_on IS NULL
     OR length(btrim(p_description)) NOT BETWEEN 2 AND 500
     OR length(btrim(p_created_by)) NOT BETWEEN 2 AND 200
     OR jsonb_typeof(p_metadata)<>'object' THEN
    RAISE EXCEPTION 'matriz_ledger_invalid_transaction';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'account_code',e.account_code,
           'account_class',e.account_class,
           'side',CASE WHEN e.side='debit' THEN 'credit' ELSE 'debit' END,
           'amount',e.amount,
           'memo',e.memo,
           'metadata',e.metadata
         ) ORDER BY e.line_no)
    INTO v_entries
    FROM finance.matriz_ledger_entries e
   WHERE e.transaction_id=v_original.id;

  v_fingerprint := md5(jsonb_build_object(
    'source_type',p_source_type,'source_id',p_source_id,
    'transaction_kind','reversal','amount',v_original.amount,
    'competence_on',p_competence_on,'due_on',NULL,'cash_on',p_cash_on,
    'description',btrim(p_description),'created_by',btrim(p_created_by),
    'entries',v_entries,'metadata',p_metadata,
    'reversal_of_transaction_id',v_original.id
  )::text);

  SELECT * INTO v_existing
    FROM finance.matriz_ledger_transactions
   WHERE environment=p_environment
     AND reversal_of_transaction_id=v_original.id;
  IF FOUND THEN
    IF v_existing.source_type<>p_source_type
       OR v_existing.source_id<>btrim(p_source_id)
       OR v_existing.request_fingerprint<>v_fingerprint THEN
      RAISE EXCEPTION 'matriz_ledger_transaction_already_reversed';
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT * INTO v_existing
    FROM finance.matriz_ledger_transactions
   WHERE environment=p_environment
     AND source_type=p_source_type
     AND source_id=btrim(p_source_id);
  IF FOUND THEN
    RAISE EXCEPTION 'matriz_ledger_idempotency_conflict';
  END IF;

  IF EXISTS (
    SELECT 1 FROM finance.matriz_ledger_payments p
    WHERE p.environment=p_environment AND p.obligation_transaction_id=v_original.id
    GROUP BY p.obligation_transaction_id
    HAVING sum(CASE WHEN p.payment_kind IN ('settlement','writeoff') THEN p.amount
      WHEN p.payment_kind='reversal' THEN -p.amount ELSE 0 END)>0
  ) THEN RAISE EXCEPTION 'matriz_ledger_reverse_has_payments'; END IF;

  INSERT INTO finance.matriz_ledger_transactions
    (environment,source_type,source_id,transaction_kind,amount,competence_on,
     cash_on,description,reversal_of_transaction_id,created_by,metadata,
     request_fingerprint)
  VALUES
    (p_environment,p_source_type,btrim(p_source_id),'reversal',
     v_original.amount,p_competence_on,p_cash_on,btrim(p_description),
     v_original.id,btrim(p_created_by),p_metadata,v_fingerprint)
  RETURNING id INTO v_id;

  INSERT INTO finance.matriz_ledger_entries
    (environment,transaction_id,line_no,account_code,account_class,side,
     amount,memo,metadata)
  SELECT p_environment,v_id,ordinality::smallint,
         line->>'account_code',line->>'account_class',line->>'side',
         (line->>'amount')::numeric,NULLIF(btrim(line->>'memo'),''),
         COALESCE(line->'metadata','{}'::jsonb)
    FROM jsonb_array_elements(v_entries) WITH ORDINALITY data(line,ordinality);
  RETURN v_id;
END
$fn$;


REVOKE ALL ON FUNCTION finance.matriz_ledger_obligation_cancelled(env_t,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.matriz_ledger_obligation_breakdown(env_t,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_matriz_obligation_payment() FROM PUBLIC;
DO $smoke$
BEGIN
  IF to_regprocedure('finance.matriz_ledger_obligation_breakdown(env_t,uuid)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='matriz_obligation_payment_open') THEN
    RAISE EXCEPTION '0254: protecao de obrigacoes nao instalada';
  END IF;
END
$smoke$;
COMMIT;
