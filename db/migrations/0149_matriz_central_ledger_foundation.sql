-- 0149 - Fundacao aditiva do livro financeiro central da Matriz.
-- Nenhum writer operacional e conectado nesta migration. O livro nasce
-- dormente, imutavel, balanceado e separado por ambiente.

CREATE TABLE finance.matriz_ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  source_type TEXT NOT NULL
    CHECK (source_type ~ '^[a-z][a-z0-9_.-]{2,119}$'),
  source_id TEXT NOT NULL
    CHECK (length(btrim(source_id)) BETWEEN 1 AND 200),
  transaction_kind TEXT NOT NULL
    CHECK (transaction_kind ~ '^[a-z][a-z0-9_.-]{2,79}$'),
  amount NUMERIC(14,2) NOT NULL CHECK (amount>0),
  competence_on DATE NOT NULL,
  due_on DATE,
  cash_on DATE,
  description TEXT NOT NULL
    CHECK (length(btrim(description)) BETWEEN 2 AND 500),
  reversal_of_transaction_id UUID
    REFERENCES finance.matriz_ledger_transactions(id),
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 2 AND 200),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata)='object'),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT matriz_ledger_transactions_source_uniq
    UNIQUE (environment,source_type,source_id),
  CONSTRAINT matriz_ledger_transactions_not_self_reversal
    CHECK (reversal_of_transaction_id IS NULL
      OR reversal_of_transaction_id<>id),
  CONSTRAINT matriz_ledger_transactions_reversal_kind_check
    CHECK (
      (reversal_of_transaction_id IS NULL AND transaction_kind<>'reversal')
      OR
      (reversal_of_transaction_id IS NOT NULL AND transaction_kind='reversal')
    )
);

CREATE UNIQUE INDEX matriz_ledger_transactions_one_reversal_uniq
  ON finance.matriz_ledger_transactions(environment,reversal_of_transaction_id)
  WHERE reversal_of_transaction_id IS NOT NULL;
CREATE INDEX matriz_ledger_transactions_competence_idx
  ON finance.matriz_ledger_transactions(environment,competence_on,transaction_kind);
CREATE INDEX matriz_ledger_transactions_cash_idx
  ON finance.matriz_ledger_transactions(environment,cash_on)
  WHERE cash_on IS NOT NULL;

CREATE TABLE finance.matriz_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  transaction_id UUID NOT NULL
    REFERENCES finance.matriz_ledger_transactions(id),
  line_no SMALLINT NOT NULL CHECK (line_no>0),
  account_code TEXT NOT NULL
    CHECK (account_code ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  account_class TEXT NOT NULL
    CHECK (account_class IN ('asset','liability','equity','revenue','expense')),
  side TEXT NOT NULL CHECK (side IN ('debit','credit')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount>0),
  memo TEXT CHECK (memo IS NULL OR length(btrim(memo)) BETWEEN 2 AND 300),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT matriz_ledger_entries_line_uniq
    UNIQUE (environment,transaction_id,line_no)
);

CREATE INDEX matriz_ledger_entries_account_idx
  ON finance.matriz_ledger_entries(environment,account_code,created_at);

CREATE TABLE finance.matriz_ledger_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  obligation_transaction_id UUID NOT NULL
    REFERENCES finance.matriz_ledger_transactions(id),
  payment_transaction_id UUID NOT NULL
    REFERENCES finance.matriz_ledger_transactions(id),
  payment_kind TEXT NOT NULL CHECK (payment_kind IN ('settlement','reversal')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount>0),
  paid_at TIMESTAMPTZ NOT NULL,
  reversal_of_payment_id UUID
    REFERENCES finance.matriz_ledger_payments(id),
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 2 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT matriz_ledger_payments_transaction_uniq
    UNIQUE (environment,payment_transaction_id),
  CONSTRAINT matriz_ledger_payments_one_reversal_uniq
    UNIQUE (environment,reversal_of_payment_id),
  CONSTRAINT matriz_ledger_payments_kind_check CHECK (
    (payment_kind='settlement' AND reversal_of_payment_id IS NULL)
    OR
    (payment_kind='reversal' AND reversal_of_payment_id IS NOT NULL)
  ),
  CONSTRAINT matriz_ledger_payments_distinct_transactions CHECK (
    obligation_transaction_id<>payment_transaction_id
  )
);

CREATE INDEX matriz_ledger_payments_obligation_idx
  ON finance.matriz_ledger_payments(environment,obligation_transaction_id,paid_at);

CREATE TRIGGER env_match_matriz_ledger_reversal
  BEFORE INSERT OR UPDATE OF reversal_of_transaction_id
  ON finance.matriz_ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','matriz_ledger_transactions','reversal_of_transaction_id');
CREATE TRIGGER env_match_matriz_ledger_entry_transaction
  BEFORE INSERT OR UPDATE OF transaction_id
  ON finance.matriz_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','matriz_ledger_transactions','transaction_id');
CREATE TRIGGER env_match_matriz_ledger_payment_obligation
  BEFORE INSERT OR UPDATE OF obligation_transaction_id
  ON finance.matriz_ledger_payments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','matriz_ledger_transactions','obligation_transaction_id');
CREATE TRIGGER env_match_matriz_ledger_payment_transaction
  BEFORE INSERT OR UPDATE OF payment_transaction_id
  ON finance.matriz_ledger_payments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','matriz_ledger_transactions','payment_transaction_id');
CREATE TRIGGER env_match_matriz_ledger_payment_reversal
  BEFORE INSERT OR UPDATE OF reversal_of_payment_id
  ON finance.matriz_ledger_payments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'finance','matriz_ledger_payments','reversal_of_payment_id');

CREATE OR REPLACE FUNCTION finance.guard_matriz_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'matriz_ledger_immutable';
END
$fn$;

CREATE TRIGGER matriz_ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON finance.matriz_ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_ledger_immutable();
CREATE TRIGGER matriz_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON finance.matriz_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_ledger_immutable();
CREATE TRIGGER matriz_ledger_payments_immutable
  BEFORE UPDATE OR DELETE ON finance.matriz_ledger_payments
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_ledger_immutable();

CREATE OR REPLACE FUNCTION finance.assert_matriz_ledger_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_transaction_id UUID;
  v_expected NUMERIC(14,2);
  v_reversal_of UUID;
  v_lines INTEGER;
  v_debits NUMERIC(14,2);
  v_credits NUMERIC(14,2);
BEGIN
  IF TG_TABLE_NAME='matriz_ledger_transactions' THEN
    v_transaction_id := COALESCE(NEW.id,OLD.id);
  ELSE
    v_transaction_id := COALESCE(NEW.transaction_id,OLD.transaction_id);
  END IF;

  SELECT t.amount,t.reversal_of_transaction_id
    INTO v_expected,v_reversal_of
    FROM finance.matriz_ledger_transactions t
   WHERE t.id=v_transaction_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*)::int,
         COALESCE(sum(e.amount) FILTER (WHERE e.side='debit'),0),
         COALESCE(sum(e.amount) FILTER (WHERE e.side='credit'),0)
    INTO v_lines,v_debits,v_credits
    FROM finance.matriz_ledger_entries e
   WHERE e.transaction_id=v_transaction_id;

  IF v_lines<2 OR v_debits<>v_expected OR v_credits<>v_expected THEN
    RAISE EXCEPTION 'matriz_ledger_unbalanced:%:expected=%:debits=%:credits=%',
      v_transaction_id,v_expected,v_debits,v_credits;
  END IF;

  IF v_reversal_of IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM finance.matriz_ledger_transactions original
       WHERE original.id=v_reversal_of
         AND original.reversal_of_transaction_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'matriz_ledger_reversal_of_reversal_forbidden';
    END IF;

    IF EXISTS (
      WITH expected AS (
        SELECT e.account_code,e.account_class,
               CASE WHEN e.side='debit' THEN 'credit' ELSE 'debit' END side,
               sum(e.amount)::numeric(14,2) amount
          FROM finance.matriz_ledger_entries e
         WHERE e.transaction_id=v_reversal_of
         GROUP BY e.account_code,e.account_class,
                  CASE WHEN e.side='debit' THEN 'credit' ELSE 'debit' END
      ),
      actual AS (
        SELECT e.account_code,e.account_class,e.side,
               sum(e.amount)::numeric(14,2) amount
          FROM finance.matriz_ledger_entries e
         WHERE e.transaction_id=v_transaction_id
         GROUP BY e.account_code,e.account_class,e.side
      )
      SELECT 1 FROM (
        (SELECT * FROM expected EXCEPT SELECT * FROM actual)
        UNION ALL
        (SELECT * FROM actual EXCEPT SELECT * FROM expected)
      ) difference
    ) THEN
      RAISE EXCEPTION 'matriz_ledger_reversal_lines_mismatch';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER matriz_ledger_transaction_balance
  AFTER INSERT ON finance.matriz_ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.assert_matriz_ledger_balanced();
CREATE CONSTRAINT TRIGGER matriz_ledger_entry_balance
  AFTER INSERT OR UPDATE OR DELETE ON finance.matriz_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.assert_matriz_ledger_balanced();

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
  SELECT * INTO STRICT v_obligation
    FROM finance.matriz_ledger_transactions
   WHERE id=NEW.obligation_transaction_id;
  SELECT * INTO STRICT v_payment
    FROM finance.matriz_ledger_transactions
   WHERE id=NEW.payment_transaction_id;

  IF v_obligation.reversal_of_transaction_id IS NOT NULL
     OR v_obligation.transaction_kind IN ('payment','reversal')
     OR EXISTS (
       SELECT 1 FROM finance.matriz_ledger_transactions reversal
        WHERE reversal.environment=NEW.environment
          AND reversal.reversal_of_transaction_id=v_obligation.id
     ) THEN
    RAISE EXCEPTION 'matriz_ledger_invalid_obligation';
  END IF;
  IF NEW.amount<>v_payment.amount THEN
    RAISE EXCEPTION 'matriz_ledger_payment_amount_mismatch';
  END IF;

  IF NEW.payment_kind='settlement' THEN
    IF v_payment.transaction_kind<>'payment'
       OR v_payment.reversal_of_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_payment_transaction';
    END IF;
  ELSE
    SELECT * INTO STRICT v_original
      FROM finance.matriz_ledger_payments
     WHERE id=NEW.reversal_of_payment_id;
    IF v_original.payment_kind<>'settlement'
       OR v_original.obligation_transaction_id<>NEW.obligation_transaction_id
       OR v_original.amount<>NEW.amount
       OR v_payment.reversal_of_transaction_id<>v_original.payment_transaction_id THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_payment_reversal';
    END IF;
  END IF;

  SELECT COALESCE(sum(
           CASE WHEN p.payment_kind='settlement' THEN p.amount ELSE -p.amount END
         ),0)
    INTO v_net
    FROM finance.matriz_ledger_payments p
   WHERE p.obligation_transaction_id=NEW.obligation_transaction_id;
  IF v_net<0 OR v_net>v_obligation.amount THEN
    RAISE EXCEPTION 'matriz_ledger_payment_out_of_bounds';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE CONSTRAINT TRIGGER matriz_ledger_payment_integrity
  AFTER INSERT ON finance.matriz_ledger_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.assert_matriz_ledger_payment();

CREATE OR REPLACE FUNCTION finance.audit_matriz_ledger_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $fn$
BEGIN
  INSERT INTO audit.events
    (environment,domain,entity_table,entity_id,event_type,actor_label,
     idempotency_key,payload_after)
  VALUES
    (NEW.environment,'matriz_finance','finance.matriz_ledger_transactions',
     NEW.id,
     CASE WHEN NEW.reversal_of_transaction_id IS NULL
       THEN 'ledger_posted' ELSE 'ledger_reversed' END,
     NEW.created_by,NEW.source_type||':'||NEW.source_id,
     jsonb_build_object(
       'source_type',NEW.source_type,
       'source_id',NEW.source_id,
       'transaction_kind',NEW.transaction_kind,
       'amount',NEW.amount,
       'competence_on',NEW.competence_on,
       'reversal_of_transaction_id',NEW.reversal_of_transaction_id
     ));
  RETURN NEW;
END
$fn$;

CREATE TRIGGER audit_matriz_ledger_transaction
  AFTER INSERT ON finance.matriz_ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION finance.audit_matriz_ledger_transaction();

CREATE OR REPLACE FUNCTION finance.audit_matriz_ledger_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $fn$
BEGIN
  INSERT INTO audit.events
    (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
  VALUES
    (NEW.environment,'matriz_finance','finance.matriz_ledger_payments',
     NEW.id,
     CASE WHEN NEW.payment_kind='settlement'
       THEN 'ledger_payment_recorded' ELSE 'ledger_payment_reversed' END,
     NEW.created_by,
     jsonb_build_object(
       'obligation_transaction_id',NEW.obligation_transaction_id,
       'payment_transaction_id',NEW.payment_transaction_id,
       'amount',NEW.amount,
       'reversal_of_payment_id',NEW.reversal_of_payment_id
     ));
  RETURN NEW;
END
$fn$;

CREATE TRIGGER audit_matriz_ledger_payment
  AFTER INSERT ON finance.matriz_ledger_payments
  FOR EACH ROW EXECUTE FUNCTION finance.audit_matriz_ledger_payment();

CREATE OR REPLACE FUNCTION finance.post_matriz_ledger_transaction(
  p_environment env_t,
  p_source_type TEXT,
  p_source_id TEXT,
  p_transaction_kind TEXT,
  p_amount NUMERIC,
  p_competence_on DATE,
  p_description TEXT,
  p_created_by TEXT,
  p_entries JSONB,
  p_due_on DATE DEFAULT NULL,
  p_cash_on DATE DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance
AS $fn$
DECLARE
  v_id UUID;
  v_existing_fingerprint TEXT;
  v_fingerprint TEXT;
  v_lines INTEGER;
  v_debits NUMERIC;
  v_credits NUMERIC;
BEGIN
  IF p_source_type !~ '^[a-z][a-z0-9_.-]{2,119}$'
     OR length(btrim(p_source_id)) NOT BETWEEN 1 AND 200
     OR p_transaction_kind !~ '^[a-z][a-z0-9_.-]{2,79}$'
     OR p_transaction_kind='reversal'
     OR p_amount<=0 OR round(p_amount,2)<>p_amount
     OR p_competence_on IS NULL
     OR length(btrim(p_description)) NOT BETWEEN 2 AND 500
     OR length(btrim(p_created_by)) NOT BETWEEN 2 AND 200
     OR jsonb_typeof(p_metadata)<>'object'
     OR jsonb_typeof(p_entries)<>'array' THEN
    RAISE EXCEPTION 'matriz_ledger_invalid_transaction';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_entries) line
     WHERE jsonb_typeof(line)<>'object'
        OR COALESCE(line->>'account_code','')
             !~ '^[a-z][a-z0-9_.-]{1,79}$'
        OR COALESCE(line->>'account_class','')
             NOT IN ('asset','liability','equity','revenue','expense')
        OR COALESCE(line->>'side','') NOT IN ('debit','credit')
        OR COALESCE(line->>'amount','') !~ '^[0-9]+(\.[0-9]{1,2})?$'
        OR (line->>'amount')::numeric<=0
        OR (
          line ? 'memo' AND line->>'memo' IS NOT NULL
          AND length(btrim(line->>'memo')) NOT BETWEEN 2 AND 300
        )
        OR (
          line ? 'metadata'
          AND jsonb_typeof(line->'metadata')<>'object'
        )
  ) THEN
    RAISE EXCEPTION 'matriz_ledger_invalid_entry';
  END IF;

  SELECT count(*)::int,
         COALESCE(sum((line->>'amount')::numeric)
           FILTER (WHERE line->>'side'='debit'),0),
         COALESCE(sum((line->>'amount')::numeric)
           FILTER (WHERE line->>'side'='credit'),0)
    INTO v_lines,v_debits,v_credits
    FROM jsonb_array_elements(p_entries) line;
  IF v_lines<2 OR v_debits<>p_amount OR v_credits<>p_amount THEN
    RAISE EXCEPTION 'matriz_ledger_unbalanced';
  END IF;

  v_fingerprint := md5(jsonb_build_object(
    'source_type',p_source_type,'source_id',p_source_id,
    'transaction_kind',p_transaction_kind,'amount',p_amount,
    'competence_on',p_competence_on,'due_on',p_due_on,'cash_on',p_cash_on,
    'description',btrim(p_description),'created_by',btrim(p_created_by),
    'entries',p_entries,'metadata',p_metadata
  )::text);

  INSERT INTO finance.matriz_ledger_transactions
    (environment,source_type,source_id,transaction_kind,amount,competence_on,
     due_on,cash_on,description,created_by,metadata,request_fingerprint)
  VALUES
    (p_environment,p_source_type,btrim(p_source_id),p_transaction_kind,p_amount,
     p_competence_on,p_due_on,p_cash_on,btrim(p_description),
     btrim(p_created_by),p_metadata,v_fingerprint)
  ON CONFLICT (environment,source_type,source_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id,request_fingerprint INTO v_id,v_existing_fingerprint
      FROM finance.matriz_ledger_transactions
     WHERE environment=p_environment
       AND source_type=p_source_type
       AND source_id=btrim(p_source_id);
    IF v_existing_fingerprint<>v_fingerprint THEN
      RAISE EXCEPTION 'matriz_ledger_idempotency_conflict';
    END IF;
    RETURN v_id;
  END IF;

  INSERT INTO finance.matriz_ledger_entries
    (environment,transaction_id,line_no,account_code,account_class,side,
     amount,memo,metadata)
  SELECT p_environment,v_id,ordinality::smallint,
         line->>'account_code',line->>'account_class',line->>'side',
         (line->>'amount')::numeric,NULLIF(btrim(line->>'memo'),''),
         COALESCE(line->'metadata','{}'::jsonb)
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY data(line,ordinality);
  RETURN v_id;
END
$fn$;

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

CREATE OR REPLACE FUNCTION finance.record_matriz_ledger_payment(
  p_environment env_t,
  p_obligation_transaction_id UUID,
  p_payment_transaction_id UUID,
  p_paid_at TIMESTAMPTZ,
  p_created_by TEXT,
  p_reversal_of_payment_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance
AS $fn$
DECLARE
  v_obligation finance.matriz_ledger_transactions%ROWTYPE;
  v_payment finance.matriz_ledger_transactions%ROWTYPE;
  v_original finance.matriz_ledger_payments%ROWTYPE;
  v_existing finance.matriz_ledger_payments%ROWTYPE;
  v_current NUMERIC(14,2);
  v_kind TEXT;
  v_id UUID;
BEGIN
  SELECT * INTO v_obligation
    FROM finance.matriz_ledger_transactions
   WHERE environment=p_environment AND id=p_obligation_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'matriz_ledger_obligation_not_found'; END IF;
  IF v_obligation.reversal_of_transaction_id IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM finance.matriz_ledger_transactions reversal
        WHERE reversal.environment=p_environment
          AND reversal.reversal_of_transaction_id=v_obligation.id
     ) THEN
    RAISE EXCEPTION 'matriz_ledger_invalid_obligation';
  END IF;
  SELECT * INTO v_payment
    FROM finance.matriz_ledger_transactions
   WHERE environment=p_environment AND id=p_payment_transaction_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'matriz_ledger_payment_transaction_not_found'; END IF;
  IF p_paid_at IS NULL
     OR length(btrim(p_created_by)) NOT BETWEEN 2 AND 200 THEN
    RAISE EXCEPTION 'matriz_ledger_invalid_payment';
  END IF;

  SELECT * INTO v_existing
    FROM finance.matriz_ledger_payments
   WHERE environment=p_environment
     AND payment_transaction_id=p_payment_transaction_id;
  IF FOUND THEN
    IF v_existing.obligation_transaction_id<>p_obligation_transaction_id
       OR v_existing.paid_at<>p_paid_at
       OR v_existing.created_by<>btrim(p_created_by)
       OR v_existing.reversal_of_payment_id
            IS DISTINCT FROM p_reversal_of_payment_id THEN
      RAISE EXCEPTION 'matriz_ledger_payment_idempotency_conflict';
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT COALESCE(sum(
           CASE WHEN p.payment_kind='settlement' THEN p.amount ELSE -p.amount END
         ),0)
    INTO v_current
    FROM finance.matriz_ledger_payments p
   WHERE p.obligation_transaction_id=p_obligation_transaction_id;

  IF p_reversal_of_payment_id IS NULL THEN
    v_kind := 'settlement';
    IF v_payment.transaction_kind<>'payment'
       OR v_payment.reversal_of_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_payment_transaction';
    END IF;
    IF v_current+v_payment.amount>v_obligation.amount THEN
      RAISE EXCEPTION 'matriz_ledger_payment_exceeds_obligation';
    END IF;
  ELSE
    v_kind := 'reversal';
    SELECT * INTO v_original
      FROM finance.matriz_ledger_payments
     WHERE environment=p_environment AND id=p_reversal_of_payment_id
     FOR UPDATE;
    IF NOT FOUND OR v_original.payment_kind<>'settlement'
       OR v_original.obligation_transaction_id<>p_obligation_transaction_id
       OR v_original.amount<>v_payment.amount
       OR v_payment.reversal_of_transaction_id<>v_original.payment_transaction_id THEN
      RAISE EXCEPTION 'matriz_ledger_invalid_payment_reversal';
    END IF;
    IF EXISTS (
      SELECT 1 FROM finance.matriz_ledger_payments
       WHERE environment=p_environment
         AND reversal_of_payment_id=p_reversal_of_payment_id
    ) THEN
      RAISE EXCEPTION 'matriz_ledger_payment_already_reversed';
    END IF;
  END IF;

  INSERT INTO finance.matriz_ledger_payments
    (environment,obligation_transaction_id,payment_transaction_id,payment_kind,
     amount,paid_at,reversal_of_payment_id,created_by)
  VALUES
    (p_environment,p_obligation_transaction_id,p_payment_transaction_id,v_kind,
     v_payment.amount,p_paid_at,p_reversal_of_payment_id,btrim(p_created_by))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$fn$;

CREATE OR REPLACE FUNCTION finance.matriz_ledger_obligation_balance(
  p_environment env_t,
  p_obligation_transaction_id UUID
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, finance
AS $fn$
  SELECT CASE WHEN EXISTS (
           SELECT 1 FROM finance.matriz_ledger_transactions reversal
            WHERE reversal.environment=t.environment
              AND reversal.reversal_of_transaction_id=t.id
         ) THEN 0::numeric
         ELSE t.amount-COALESCE(sum(
           CASE WHEN p.payment_kind='settlement' THEN p.amount ELSE -p.amount END
         ),0) END
    FROM finance.matriz_ledger_transactions t
    LEFT JOIN finance.matriz_ledger_payments p
      ON p.environment=t.environment
     AND p.obligation_transaction_id=t.id
   WHERE t.environment=p_environment
     AND t.id=p_obligation_transaction_id
   GROUP BY t.id,t.environment,t.amount
$fn$;

REVOKE ALL ON finance.matriz_ledger_transactions FROM PUBLIC;
REVOKE ALL ON finance.matriz_ledger_entries FROM PUBLIC;
REVOKE ALL ON finance.matriz_ledger_payments FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_matriz_ledger_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.assert_matriz_ledger_balanced() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.assert_matriz_ledger_payment() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.audit_matriz_ledger_transaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.audit_matriz_ledger_payment() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.post_matriz_ledger_transaction(
  env_t,TEXT,TEXT,TEXT,NUMERIC,DATE,TEXT,TEXT,JSONB,DATE,DATE,JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.reverse_matriz_ledger_transaction(
  env_t,UUID,TEXT,TEXT,DATE,TEXT,TEXT,DATE,JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.record_matriz_ledger_payment(
  env_t,UUID,UUID,TIMESTAMPTZ,TEXT,UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.matriz_ledger_obligation_balance(
  env_t,UUID
) FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON finance.matriz_ledger_transactions FROM farejador_partner_app;
    REVOKE ALL ON finance.matriz_ledger_entries FROM farejador_partner_app;
    REVOKE ALL ON finance.matriz_ledger_payments FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.guard_matriz_ledger_immutable()
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.assert_matriz_ledger_balanced()
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.assert_matriz_ledger_payment()
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.audit_matriz_ledger_transaction()
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.audit_matriz_ledger_payment()
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.post_matriz_ledger_transaction(
      env_t,TEXT,TEXT,TEXT,NUMERIC,DATE,TEXT,TEXT,JSONB,DATE,DATE,JSONB
    ) FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.reverse_matriz_ledger_transaction(
      env_t,UUID,TEXT,TEXT,DATE,TEXT,TEXT,DATE,JSONB
    ) FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.record_matriz_ledger_payment(
      env_t,UUID,UUID,TIMESTAMPTZ,TEXT,UUID
    ) FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.matriz_ledger_obligation_balance(
      env_t,UUID
    ) FROM farejador_partner_app;
  END IF;
END
$security$;

COMMENT ON TABLE finance.matriz_ledger_transactions IS
  '0149: cabecalho imutavel e idempotente do livro financeiro central da Matriz; writer operacional ainda dormente.';
COMMENT ON TABLE finance.matriz_ledger_entries IS
  '0149: partidas debitadas/creditadas; cada transacao deve fechar exatamente no valor do cabecalho.';
COMMENT ON TABLE finance.matriz_ledger_payments IS
  '0149: alocacoes imutaveis de pagamentos parciais e estornos integrais contra uma obrigacao.';
