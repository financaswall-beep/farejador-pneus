BEGIN;

-- A entrega histórica continua publicada. A remoção é uma operação posterior por rede.
ALTER TABLE ops.publisher_destinations
  ADD COLUMN removal_state text,
  ADD COLUMN removal_error text,
  ADD COLUMN removal_attempt uuid,
  ADD COLUMN removal_updated_at timestamptz,
  ADD CONSTRAINT publisher_instagram_removal_valid CHECK (
    (removal_state IS NULL AND removal_attempt IS NULL AND removal_updated_at IS NULL AND removal_error IS NULL)
    OR (removal_state IS NOT NULL AND removal_state IN ('queued','sending','deleted','failed','uncertain')
      AND platform='instagram' AND status='published' AND provider_id IS NOT NULL
      AND removal_attempt IS NOT NULL AND removal_updated_at IS NOT NULL)
  );

CREATE INDEX publisher_pending_removals ON ops.publisher_destinations(environment,removal_updated_at)
  WHERE removal_state IN ('queued','sending');

COMMIT;
