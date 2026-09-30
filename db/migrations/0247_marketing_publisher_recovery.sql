-- Recuperação e inspeção de mídia da Central; mantém isolamento e RLS existentes.
BEGIN;

ALTER TABLE ops.publisher_media
  ADD COLUMN inspection jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(inspection) = 'object'),
  ADD COLUMN error_code text CHECK (error_code IS NULL OR length(error_code) <= 100),
  ADD COLUMN upload_completed_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE ops.publisher_destinations
  ADD COLUMN retry_attempts integer NOT NULL DEFAULT 0
    CHECK (retry_attempts BETWEEN 0 AND 5),
  ADD COLUMN public_started_at timestamptz;

-- Publicações que já estavam em confirmação preservam seu relógio de envio.
UPDATE ops.publisher_destinations
  SET public_started_at = coalesce(started_at, updated_at)
  WHERE status IN ('publishing','verifying','uncertain','published');

COMMIT;
