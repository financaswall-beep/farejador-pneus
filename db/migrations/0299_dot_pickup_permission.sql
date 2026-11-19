BEGIN;

ALTER TABLE network.dot_oauth_grants
  ADD COLUMN pickup_operations_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE network.dot_operation_reviews
  DROP CONSTRAINT dot_operation_reviews_permission_domain_check,
  ADD CONSTRAINT dot_operation_reviews_permission_domain_check
    CHECK (permission_domain IN ('finance','publisher','stock','catalog','pickup'));

COMMIT;
