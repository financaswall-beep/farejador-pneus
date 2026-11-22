BEGIN;

ALTER TABLE network.dot_oauth_grants
  ADD COLUMN pickup_completion_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN purchase_receipt_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE network.dot_operation_reviews
  DROP CONSTRAINT dot_operation_reviews_permission_domain_check,
  ADD CONSTRAINT dot_operation_reviews_permission_domain_check CHECK (permission_domain IN (
    'finance','publisher','stock','catalog','pickup','retail','route','pickup_completion','purchase_receipt'
  )),
  ADD CONSTRAINT dot_operation_reviews_voice_domain_channel_check CHECK (
    permission_domain NOT IN ('pickup_completion','purchase_receipt') OR decision_channel IS DISTINCT FROM 'painel'
  );

COMMIT;
