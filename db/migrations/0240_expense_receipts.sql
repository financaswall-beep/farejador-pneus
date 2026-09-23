-- Comprovantes avulsos: documento privado, sugestão isolada e vínculo confirmado.
BEGIN;
CREATE TABLE commerce.matriz_expense_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256)=32),
  mime text NOT NULL CHECK (mime='image/jpeg'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  expense_id uuid,
  linked_at timestamptz,
  reading_token uuid,
  reading_started_at timestamptz,
  UNIQUE (environment,id),
  UNIQUE (environment,content_sha256),
  UNIQUE (environment,expense_id),
  FOREIGN KEY (environment,expense_id) REFERENCES commerce.matriz_expenses(environment,id),
  CHECK ((expense_id IS NULL)=(linked_at IS NULL)),
  CHECK ((reading_token IS NULL)=(reading_started_at IS NULL))
);
CREATE TABLE commerce.matriz_expense_receipt_blobs (
  receipt_id uuid PRIMARY KEY,
  environment env_t NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 8388608),
  FOREIGN KEY (environment,receipt_id) REFERENCES commerce.matriz_expense_receipts(environment,id)
);
CREATE TABLE analytics.expense_receipt_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  receipt_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('parsed','unreadable','failed')),
  source text NOT NULL DEFAULT 'openai_vision',
  extractor_version text NOT NULL,
  prompt_version text NOT NULL,
  model text NOT NULL,
  confidence_level text NOT NULL CHECK (confidence_level IN ('high','low','unknown')),
  confidence numeric CHECK (confidence BETWEEN 0 AND 1),
  truth_type text NOT NULL DEFAULT 'suggestion' CHECK (truth_type='suggestion'),
  amount numeric(12,2) CHECK (amount>0),
  category text,
  merchant text,
  document_date date,
  summary text NOT NULL,
  previous_reading_id uuid,
  UNIQUE (environment,id),
  UNIQUE (environment,receipt_id,id),
  UNIQUE (environment,previous_reading_id),
  FOREIGN KEY (environment,receipt_id) REFERENCES commerce.matriz_expense_receipts(environment,id),
  FOREIGN KEY (environment,receipt_id,previous_reading_id) REFERENCES analytics.expense_receipt_readings(environment,receipt_id,id),
  CHECK (status<>'parsed' OR (amount IS NOT NULL AND category IS NOT NULL))
);
-- O mesmo arquivo não pode alimentar os dois fluxos, inclusive em uploads concorrentes.
CREATE FUNCTION commerce.guard_expense_receipt_hash() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE h bytea;
BEGIN
  IF TG_TABLE_NAME='matriz_expense_receipts' THEN h:=NEW.content_sha256;
  ELSE h:=sha256(NEW.bytes); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.environment::text || ':' || encode(h,'hex'),0));
  IF TG_TABLE_NAME='matriz_expense_receipts' THEN
    IF EXISTS (SELECT 1 FROM commerce.matriz_trip_receipt_blobs WHERE environment=NEW.environment AND content_sha256=h) THEN
      RAISE EXCEPTION 'receipt_belongs_to_trip';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM commerce.matriz_expense_receipts WHERE environment=NEW.environment AND content_sha256=h) THEN
    RAISE EXCEPTION 'receipt_belongs_to_expense';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expense_receipt_cross_dedup BEFORE INSERT ON commerce.matriz_expense_receipts
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_expense_receipt_hash();
CREATE TRIGGER expense_receipt_cross_dedup BEFORE INSERT ON commerce.matriz_trip_receipt_blobs
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_expense_receipt_hash();
CREATE FUNCTION commerce.protect_expense_receipt_blob() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'expense_receipt_blob_immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce.matriz_expense_receipts r WHERE r.environment=NEW.environment
    AND r.id=NEW.receipt_id AND r.content_sha256=sha256(NEW.bytes) AND r.size_bytes=octet_length(NEW.bytes)) THEN
    RAISE EXCEPTION 'expense_receipt_blob_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expense_receipt_blob_immutable BEFORE INSERT OR UPDATE OR DELETE ON commerce.matriz_expense_receipt_blobs
  FOR EACH ROW EXECUTE FUNCTION commerce.protect_expense_receipt_blob();
CREATE INDEX expense_receipt_readings_latest ON analytics.expense_receipt_readings(environment,receipt_id,created_at DESC,id DESC);
-- A referência superseded_by é derivada da próxima leitura, preservando as linhas originais sem UPDATE.
CREATE VIEW analytics.expense_receipt_reading_history WITH (security_invoker=true) AS
  SELECT a.*,n.id AS superseded_by FROM analytics.expense_receipt_readings a
  LEFT JOIN analytics.expense_receipt_readings n ON n.environment=a.environment AND n.previous_reading_id=a.id;
CREATE FUNCTION analytics.keep_expense_receipt_readings_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'expense_receipt_reading_immutable'; END $$;
CREATE TRIGGER expense_receipt_readings_immutable BEFORE UPDATE OR DELETE ON analytics.expense_receipt_readings
  FOR EACH ROW EXECUTE FUNCTION analytics.keep_expense_receipt_readings_immutable();
ALTER TABLE commerce.matriz_expense_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.matriz_expense_receipt_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.expense_receipt_readings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.matriz_expense_receipts,commerce.matriz_expense_receipt_blobs,analytics.expense_receipt_readings FROM PUBLIC,farejador_partner_app;
REVOKE ALL ON analytics.expense_receipt_reading_history FROM PUBLIC,farejador_partner_app;
REVOKE ALL ON FUNCTION analytics.keep_expense_receipt_readings_immutable() FROM PUBLIC,farejador_partner_app;
REVOKE ALL ON FUNCTION commerce.guard_expense_receipt_hash(),commerce.protect_expense_receipt_blob() FROM PUBLIC,farejador_partner_app;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON commerce.matriz_expense_receipts,commerce.matriz_expense_receipt_blobs,analytics.expense_receipt_readings FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON analytics.expense_receipt_reading_history FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMENT ON TABLE analytics.expense_receipt_readings IS 'Sugestões imutáveis. Nova leitura referencia a anterior; somente confirmação autenticada cria uma despesa.';
COMMIT;
