-- ============================================================
-- 0140_matriz_receipt_human_approval.sql
-- ETAPA 7 — comprovante sugere; somente decisão humana cria dinheiro.
--
-- A migration preserva todo legado, separa extração de revisão e fecha no
-- banco o caminho antigo que ligava uma despesa automaticamente ao recibo.
-- Dado exclusivo da matriz: zero grant para farejador_partner_app.
-- ============================================================

-- 1. Preflight: a 0140 não corrige silenciosamente incoerência anterior.
DO $preflight$
DECLARE
  v_count INTEGER;
BEGIN
  IF to_regclass('commerce.matriz_trip_receipts') IS NULL
     OR to_regclass('commerce.matriz_trip_receipt_blobs') IS NULL
     OR to_regclass('commerce.matriz_expenses') IS NULL THEN
    RAISE EXCEPTION '0140_preflight_missing_logistics_or_expenses';
  END IF;

  SELECT count(*) INTO v_count
    FROM commerce.matriz_trip_receipts r
    LEFT JOIN commerce.matriz_trip_receipt_blobs b ON b.receipt_id = r.id
   WHERE b.receipt_id IS NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0140_preflight_receipt_without_blob:%', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM commerce.matriz_trip_receipts r
    JOIN commerce.matriz_delivery_trips t ON t.id = r.trip_id
   WHERE r.environment IS DISTINCT FROM t.environment;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0140_preflight_receipt_trip_environment:%', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM commerce.matriz_trip_receipt_blobs b
    JOIN commerce.matriz_trip_receipts r ON r.id = b.receipt_id
   WHERE b.environment IS DISTINCT FROM r.environment;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0140_preflight_blob_receipt_environment:%', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM commerce.matriz_trip_receipts r
    JOIN commerce.matriz_expenses e ON e.id = r.ai_expense_id
   WHERE r.environment IS DISTINCT FROM e.environment;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0140_preflight_receipt_expense_environment:%', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM commerce.matriz_delivery_trips t
    JOIN commerce.matriz_expenses e ON e.id = t.fuel_expense_id
   WHERE t.environment IS DISTINCT FROM e.environment;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0140_preflight_trip_expense_environment:%', v_count;
  END IF;
END;
$preflight$;

-- 2. Datas financeiras e uma única régua de competência.
ALTER TABLE commerce.matriz_expenses
  ADD COLUMN IF NOT EXISTS document_date DATE,
  ADD COLUMN IF NOT EXISTS competence_month DATE;

ALTER TABLE commerce.matriz_expenses
  DROP CONSTRAINT IF EXISTS matriz_expenses_competence_month_check;
ALTER TABLE commerce.matriz_expenses
  ADD CONSTRAINT matriz_expenses_competence_month_check
  CHECK (competence_month IS NULL OR competence_month = date_trunc('month', competence_month)::date);

CREATE OR REPLACE FUNCTION ops.matriz_expense_competence_month(
  p_competence_month DATE,
  p_occurred_at TIMESTAMPTZ
) RETURNS DATE
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(
    p_competence_month,
    date_trunc('month', p_occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
  );
$fn$;

COMMENT ON FUNCTION ops.matriz_expense_competence_month(DATE, TIMESTAMPTZ) IS
  '0140: competência explícita; para legado/manual usa o mês de occurred_at em America/Sao_Paulo.';

REVOKE ALL ON FUNCTION ops.matriz_expense_competence_month(DATE, TIMESTAMPTZ) FROM PUBLIC;
DO $revoke_competence$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON FUNCTION ops.matriz_expense_competence_month(DATE, TIMESTAMPTZ)
      FROM farejador_partner_app;
  END IF;
END;
$revoke_competence$;

-- 3. Hash do blob. Descobre o schema real de pgcrypto (extensions no
-- Supabase; public no PostgreSQL descartável) e prova digest antes do DDL.
DO $hash$
DECLARE
  v_schema TEXT;
  v_hash BYTEA;
BEGIN
  SELECT n.nspname INTO v_schema
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'digest'
     AND p.proargtypes = '17 25'::oidvector
   ORDER BY CASE n.nspname WHEN 'extensions' THEN 0 WHEN 'public' THEN 1 ELSE 2 END
   LIMIT 1;
  IF v_schema IS NULL THEN
    RAISE EXCEPTION '0140_digest_bytea_text_not_found';
  END IF;

  EXECUTE format('SELECT %I.digest($1::bytea, $2::text)', v_schema)
    INTO v_hash USING convert_to('abc', 'UTF8'), 'sha256';
  IF encode(v_hash, 'hex') <> 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' THEN
    RAISE EXCEPTION '0140_digest_smoke_failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='commerce' AND table_name='matriz_trip_receipt_blobs'
       AND column_name='content_sha256'
  ) THEN
    EXECUTE format(
      'ALTER TABLE commerce.matriz_trip_receipt_blobs ADD COLUMN content_sha256 BYTEA GENERATED ALWAYS AS (%I.digest(bytes, %L)) STORED',
      v_schema, 'sha256'
    );
  END IF;
END;
$hash$;

ALTER TABLE commerce.matriz_trip_receipt_blobs
  ADD COLUMN IF NOT EXISTS dedup_enforced BOOLEAN;
UPDATE commerce.matriz_trip_receipt_blobs
   SET dedup_enforced = false
 WHERE dedup_enforced IS NULL;
ALTER TABLE commerce.matriz_trip_receipt_blobs
  ALTER COLUMN dedup_enforced SET DEFAULT true,
  ALTER COLUMN dedup_enforced SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS matriz_receipt_blob_sha256_new_uniq
  ON commerce.matriz_trip_receipt_blobs(environment, content_sha256)
  WHERE dedup_enforced;

CREATE OR REPLACE FUNCTION commerce.protect_matriz_receipt_blob()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = commerce, pg_catalog
AS $fn$
DECLARE
  v_hash BYTEA;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.dedup_enforced IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_dedup_required';
    END IF;
    v_hash := pg_catalog.sha256(NEW.bytes);
    IF EXISTS (
      SELECT 1 FROM commerce.matriz_trip_receipt_blobs b
       WHERE b.environment = NEW.environment
         AND b.content_sha256 = v_hash
         AND b.receipt_id <> NEW.receipt_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='receipt_exact_duplicate';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.dedup_enforced IS DISTINCT FROM OLD.dedup_enforced THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_blob_immutable';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS protect_matriz_receipt_blob_trigger
  ON commerce.matriz_trip_receipt_blobs;
CREATE TRIGGER protect_matriz_receipt_blob_trigger
  BEFORE INSERT OR UPDATE ON commerce.matriz_trip_receipt_blobs
  FOR EACH ROW EXECUTE FUNCTION commerce.protect_matriz_receipt_blob();

-- 4. Workflow: backfill antes da constraint fail-closed.
ALTER TABLE commerce.matriz_trip_receipts
  ADD COLUMN IF NOT EXISTS workflow_status TEXT;

UPDATE commerce.matriz_trip_receipts
   SET workflow_status = CASE
     WHEN ai_expense_id IS NOT NULL THEN 'legacy_linked'
     ELSE 'review_required'
   END
 WHERE workflow_status IS NULL;

DO $workflow_backfill$
DECLARE
  v_bad INTEGER;
BEGIN
  SELECT count(*) INTO v_bad
    FROM commerce.matriz_trip_receipts
   WHERE workflow_status IS NULL
      OR (ai_expense_id IS NOT NULL AND workflow_status <> 'legacy_linked')
      OR (ai_expense_id IS NULL AND workflow_status <> 'review_required');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '0140_workflow_backfill_failed:%', v_bad;
  END IF;
END;
$workflow_backfill$;

ALTER TABLE commerce.matriz_trip_receipts
  ALTER COLUMN workflow_status SET DEFAULT 'uploaded',
  ALTER COLUMN workflow_status SET NOT NULL,
  DROP CONSTRAINT IF EXISTS matriz_trip_receipts_check,
  DROP CONSTRAINT IF EXISTS matriz_trip_receipts_workflow_status_check,
  DROP CONSTRAINT IF EXISTS matriz_trip_receipts_workflow_link_check;

ALTER TABLE commerce.matriz_trip_receipts
  ADD CONSTRAINT matriz_trip_receipts_workflow_status_check
    CHECK (workflow_status IN (
      'uploaded','processing','review_required','linked','rejected','legacy_linked'
    )),
  ADD CONSTRAINT matriz_trip_receipts_workflow_link_check CHECK (
    (workflow_status IN ('linked','legacy_linked') AND ai_expense_id IS NOT NULL)
    OR
    (workflow_status IN ('uploaded','processing','review_required','rejected') AND ai_expense_id IS NULL)
  );

COMMENT ON COLUMN commerce.matriz_trip_receipts.workflow_status IS
  '0140: revisão financeira separada da extração. Só linked/legacy_linked têm ai_expense_id.';

-- 5. Chaves compostas fecham ambiente cruzado.
DO $unique_keys$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='matriz_delivery_trips_environment_id_key') THEN
    ALTER TABLE commerce.matriz_delivery_trips
      ADD CONSTRAINT matriz_delivery_trips_environment_id_key UNIQUE(environment,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='matriz_expenses_environment_id_key') THEN
    ALTER TABLE commerce.matriz_expenses
      ADD CONSTRAINT matriz_expenses_environment_id_key UNIQUE(environment,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='matriz_trip_receipts_environment_id_key') THEN
    ALTER TABLE commerce.matriz_trip_receipts
      ADD CONSTRAINT matriz_trip_receipts_environment_id_key UNIQUE(environment,id);
  END IF;
END;
$unique_keys$;

ALTER TABLE commerce.matriz_delivery_trips
  DROP CONSTRAINT IF EXISTS matriz_delivery_trips_fuel_expense_id_fkey;
ALTER TABLE commerce.matriz_delivery_trips
  ADD CONSTRAINT matriz_delivery_trips_fuel_expense_environment_fk
  FOREIGN KEY (environment,fuel_expense_id)
  REFERENCES commerce.matriz_expenses(environment,id);

ALTER TABLE commerce.matriz_trip_receipts
  DROP CONSTRAINT IF EXISTS matriz_trip_receipts_trip_id_fkey,
  DROP CONSTRAINT IF EXISTS matriz_trip_receipts_ai_expense_id_fkey;
ALTER TABLE commerce.matriz_trip_receipts
  ADD CONSTRAINT matriz_trip_receipts_trip_environment_fk
    FOREIGN KEY (environment,trip_id)
    REFERENCES commerce.matriz_delivery_trips(environment,id) ON DELETE CASCADE,
  ADD CONSTRAINT matriz_trip_receipts_expense_environment_fk
    FOREIGN KEY (environment,ai_expense_id)
    REFERENCES commerce.matriz_expenses(environment,id);

ALTER TABLE commerce.matriz_trip_receipt_blobs
  DROP CONSTRAINT IF EXISTS matriz_trip_receipt_blobs_receipt_id_fkey;
ALTER TABLE commerce.matriz_trip_receipt_blobs
  ADD CONSTRAINT matriz_trip_receipt_blobs_receipt_environment_fk
  FOREIGN KEY (environment,receipt_id)
  REFERENCES commerce.matriz_trip_receipts(environment,id) ON DELETE CASCADE;

-- 6. Tentativas da IA: processamento pode virar terminal uma vez.
CREATE TABLE IF NOT EXISTS commerce.matriz_trip_receipt_ai_attempts (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment                   env_t NOT NULL,
  receipt_id                    UUID NOT NULL,
  attempt_no                    INTEGER NOT NULL CHECK (attempt_no > 0),
  status                        TEXT NOT NULL CHECK (status IN ('processing','suggested','unreadable','failed')),
  suggested_amount              NUMERIC(12,2) CHECK (suggested_amount IS NULL OR suggested_amount > 0),
  suggested_category            TEXT,
  suggested_merchant            TEXT,
  suggested_merchant_normalized TEXT,
  suggested_document_date       DATE,
  confidence                    NUMERIC(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  summary                       TEXT,
  error_code                    TEXT,
  model                         TEXT NOT NULL,
  extractor_version             TEXT NOT NULL,
  prompt_version                TEXT NOT NULL,
  started_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at                   TIMESTAMPTZ,
  CONSTRAINT matriz_receipt_attempt_terminal_check CHECK (
    (status='processing' AND finished_at IS NULL)
    OR (status<>'processing' AND finished_at IS NOT NULL)
  ),
  CONSTRAINT matriz_receipt_attempt_receipt_fk
    FOREIGN KEY (environment,receipt_id)
    REFERENCES commerce.matriz_trip_receipts(environment,id) ON DELETE CASCADE,
  CONSTRAINT matriz_receipt_attempt_category_fk
    FOREIGN KEY (environment,suggested_category)
    REFERENCES commerce.matriz_expense_categories(environment,slug),
  UNIQUE(environment,receipt_id,attempt_no),
  UNIQUE(environment,receipt_id,id)
);

CREATE UNIQUE INDEX IF NOT EXISTS matriz_receipt_attempt_one_processing_uniq
  ON commerce.matriz_trip_receipt_ai_attempts(environment,receipt_id)
  WHERE status='processing';

CREATE OR REPLACE FUNCTION commerce.protect_matriz_receipt_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = commerce, pg_catalog
AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_attempt_immutable';
  END IF;
  IF OLD.status <> 'processing' OR NEW.status = 'processing'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
     OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.extractor_version IS DISTINCT FROM OLD.extractor_version
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_attempt_immutable';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS protect_matriz_receipt_attempt_trigger
  ON commerce.matriz_trip_receipt_ai_attempts;
CREATE TRIGGER protect_matriz_receipt_attempt_trigger
  BEFORE UPDATE OR DELETE ON commerce.matriz_trip_receipt_ai_attempts
  FOR EACH ROW EXECUTE FUNCTION commerce.protect_matriz_receipt_attempt();

-- 7. Decisão humana terminal e append-only.
CREATE TABLE IF NOT EXISTS commerce.matriz_trip_receipt_decisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment         env_t NOT NULL,
  receipt_id          UUID NOT NULL,
  attempt_id          UUID,
  action              TEXT NOT NULL CHECK (action IN ('approve','reject')),
  content_sha256      BYTEA NOT NULL,
  actor_admin_id      UUID,
  actor_label         TEXT NOT NULL CHECK (length(btrim(actor_label)) BETWEEN 1 AND 200),
  suggestion_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_amount     NUMERIC(12,2),
  approved_category   TEXT,
  approved_merchant   TEXT,
  document_date       DATE,
  competence_month    DATE,
  payment_status      TEXT CHECK (payment_status IN ('paid','pending')),
  payment_date        DATE,
  due_date            DATE,
  reason              TEXT,
  differences         JSONB NOT NULL DEFAULT '{}'::jsonb,
  expense_id          UUID,
  idempotency_key     TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT matriz_receipt_decision_competence_check CHECK (
    competence_month IS NULL OR competence_month=date_trunc('month',competence_month)::date
  ),
  CONSTRAINT matriz_receipt_decision_action_check CHECK (
    (action='reject'
      AND length(btrim(reason)) >= 2
      AND expense_id IS NULL
      AND approved_amount IS NULL
      AND approved_category IS NULL
      AND document_date IS NULL
      AND competence_month IS NULL
      AND payment_status IS NULL
      AND payment_date IS NULL
      AND due_date IS NULL)
    OR
    (action='approve'
      AND expense_id IS NOT NULL
      AND approved_amount > 0
      AND approved_category IS NOT NULL
      AND document_date IS NOT NULL
      AND competence_month IS NOT NULL
      AND (
        (payment_status='paid' AND payment_date IS NOT NULL AND due_date IS NULL)
        OR (payment_status='pending' AND due_date IS NOT NULL AND payment_date IS NULL)
      ))
  ),
  CONSTRAINT matriz_receipt_decision_receipt_fk
    FOREIGN KEY (environment,receipt_id)
    REFERENCES commerce.matriz_trip_receipts(environment,id),
  CONSTRAINT matriz_receipt_decision_attempt_fk
    FOREIGN KEY (environment,receipt_id,attempt_id)
    REFERENCES commerce.matriz_trip_receipt_ai_attempts(environment,receipt_id,id),
  CONSTRAINT matriz_receipt_decision_category_fk
    FOREIGN KEY (environment,approved_category)
    REFERENCES commerce.matriz_expense_categories(environment,slug),
  CONSTRAINT matriz_receipt_decision_expense_fk
    FOREIGN KEY (environment,expense_id)
    REFERENCES commerce.matriz_expenses(environment,id),
  UNIQUE(environment,receipt_id)
);

CREATE OR REPLACE FUNCTION commerce.protect_matriz_receipt_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = commerce, pg_catalog
AS $fn$
DECLARE
  v_hash BYTEA;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_decision_immutable';
  END IF;
  SELECT b.content_sha256 INTO v_hash
    FROM commerce.matriz_trip_receipt_blobs b
   WHERE b.environment=NEW.environment AND b.receipt_id=NEW.receipt_id;
  IF v_hash IS NULL OR v_hash IS DISTINCT FROM NEW.content_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_content_hash_mismatch';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS protect_matriz_receipt_decision_trigger
  ON commerce.matriz_trip_receipt_decisions;
CREATE TRIGGER protect_matriz_receipt_decision_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON commerce.matriz_trip_receipt_decisions
  FOR EACH ROW EXECUTE FUNCTION commerce.protect_matriz_receipt_decision();

-- 7b. Portas fail-closed para uma janela de rollout em que código antigo ainda
-- esteja rodando: fechamento não pode mais criar/colar fuel_expense_id, e nenhum
-- receipt ganha vínculo/rejeição terminal sem a decisão humana correspondente.
CREATE OR REPLACE FUNCTION commerce.protect_matriz_trip_fuel_expense_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = commerce, pg_catalog
AS $fn$
BEGIN
  IF NEW.fuel_expense_id IS DISTINCT FROM OLD.fuel_expense_id THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_human_approval_required';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS protect_matriz_trip_fuel_expense_link_trigger
  ON commerce.matriz_delivery_trips;
CREATE TRIGGER protect_matriz_trip_fuel_expense_link_trigger
  BEFORE UPDATE ON commerce.matriz_delivery_trips
  FOR EACH ROW EXECUTE FUNCTION commerce.protect_matriz_trip_fuel_expense_link();

CREATE OR REPLACE FUNCTION commerce.protect_matriz_receipt_terminal_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = commerce, pg_catalog
AS $fn$
BEGIN
  IF TG_OP='INSERT' AND NEW.workflow_status IN ('linked','rejected','legacy_linked') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_human_decision_required';
  END IF;
  IF TG_OP='UPDATE' AND OLD.workflow_status IN ('linked','rejected','legacy_linked')
     AND (NEW.workflow_status IS DISTINCT FROM OLD.workflow_status
          OR NEW.ai_expense_id IS DISTINCT FROM OLD.ai_expense_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_terminal_immutable';
  END IF;
  IF TG_OP='UPDATE' AND NEW.workflow_status='linked'
     AND NOT EXISTS (
       SELECT 1 FROM commerce.matriz_trip_receipt_decisions d
        WHERE d.environment=NEW.environment AND d.receipt_id=NEW.id
          AND d.action='approve' AND d.expense_id=NEW.ai_expense_id
     ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_human_decision_required';
  END IF;
  IF TG_OP='UPDATE' AND NEW.workflow_status='rejected'
     AND NOT EXISTS (
       SELECT 1 FROM commerce.matriz_trip_receipt_decisions d
        WHERE d.environment=NEW.environment AND d.receipt_id=NEW.id AND d.action='reject'
     ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='receipt_human_decision_required';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS protect_matriz_receipt_terminal_transition_trigger
  ON commerce.matriz_trip_receipts;
CREATE TRIGGER protect_matriz_receipt_terminal_transition_trigger
  BEFORE INSERT OR UPDATE ON commerce.matriz_trip_receipts
  FOR EACH ROW EXECUTE FUNCTION commerce.protect_matriz_receipt_terminal_transition();

-- 8. Segurança: nenhum privilégio de tabela/coluna/função para parceiro.
DO $security$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'commerce.matriz_trip_receipt_ai_attempts',
      'commerce.matriz_trip_receipt_decisions'
    ] LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM farejador_partner_app', t);
    END LOOP;
    REVOKE ALL (document_date,competence_month)
      ON commerce.matriz_expenses FROM farejador_partner_app;
    REVOKE ALL (workflow_status)
      ON commerce.matriz_trip_receipts FROM farejador_partner_app;
    REVOKE ALL (content_sha256,dedup_enforced)
      ON commerce.matriz_trip_receipt_blobs FROM farejador_partner_app;
  END IF;
END;
$security$;

REVOKE ALL ON FUNCTION commerce.protect_matriz_receipt_blob() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.protect_matriz_receipt_attempt() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.protect_matriz_receipt_decision() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.protect_matriz_trip_fuel_expense_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.protect_matriz_receipt_terminal_transition() FROM PUBLIC;

-- 9. Validação e smoke transacional. Se falhar, toda a migration reverte.
DO $check$
DECLARE
  v_trip1 UUID;
  v_trip2 UUID;
  v_receipt1 UUID;
  v_receipt2 UUID;
  v_hash TEXT;
  v_duplicate_blocked BOOLEAN := false;
  v_allowed BOOLEAN;
  t TEXT;
  p TEXT;
BEGIN
  IF to_regclass('commerce.matriz_trip_receipt_ai_attempts') IS NULL
     OR to_regclass('commerce.matriz_trip_receipt_decisions') IS NULL THEN
    RAISE EXCEPTION '0140_validation_missing_tables';
  END IF;

  INSERT INTO commerce.matriz_delivery_trips(environment,courier_name)
  VALUES ('test','0140-smoke-1') RETURNING id INTO v_trip1;
  INSERT INTO commerce.matriz_delivery_trips(environment,courier_name)
  VALUES ('test','0140-smoke-2') RETURNING id INTO v_trip2;
  INSERT INTO commerce.matriz_trip_receipts(environment,trip_id,mime,size_bytes,ai_status,workflow_status)
  VALUES ('test',v_trip1,'image/jpeg',3,'pending','uploaded') RETURNING id INTO v_receipt1;
  INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
  VALUES (v_receipt1,'test',convert_to('abc','UTF8'));

  SELECT encode(content_sha256,'hex') INTO v_hash
    FROM commerce.matriz_trip_receipt_blobs WHERE receipt_id=v_receipt1;
  IF v_hash <> 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' THEN
    RAISE EXCEPTION '0140_generated_hash_smoke_failed:%', v_hash;
  END IF;

  INSERT INTO commerce.matriz_trip_receipts(environment,trip_id,mime,size_bytes,ai_status,workflow_status)
  VALUES ('test',v_trip2,'image/jpeg',3,'pending','uploaded') RETURNING id INTO v_receipt2;
  BEGIN
    INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
    VALUES (v_receipt2,'test',convert_to('abc','UTF8'));
  EXCEPTION WHEN unique_violation THEN
    v_duplicate_blocked := true;
  END;
  IF NOT v_duplicate_blocked THEN
    RAISE EXCEPTION '0140_duplicate_smoke_not_blocked';
  END IF;

  DELETE FROM commerce.matriz_delivery_trips WHERE id IN (v_trip1,v_trip2);

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'commerce.matriz_trip_receipt_ai_attempts',
      'commerce.matriz_trip_receipt_decisions'
    ] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        SELECT has_table_privilege('farejador_partner_app',t,p) INTO v_allowed;
        IF v_allowed THEN
          RAISE EXCEPTION '0140_partner_privilege:%:%', t, p;
        END IF;
      END LOOP;
    END LOOP;
    SELECT has_function_privilege(
      'farejador_partner_app',
      'ops.matriz_expense_competence_month(date,timestamp with time zone)',
      'EXECUTE'
    ) INTO v_allowed;
    IF v_allowed THEN
      RAISE EXCEPTION '0140_partner_competence_execute';
    END IF;
  END IF;

  RAISE NOTICE '0140 OK: hash, dedup, workflow, tentativas, decisoes, competencia e grants validados.';
END;
$check$;

-- Rollback operacional: desligar MATRIZ_RECEIPT_APPROVAL volta a esconder as
-- rotas de decisão. Rollback estrutural só depois de remover dados 0140 e
-- restaurar a constraint antiga; nunca executar automaticamente.
