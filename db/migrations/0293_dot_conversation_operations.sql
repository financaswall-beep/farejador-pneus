BEGIN;
ALTER TABLE network.dot_oauth_grants
  ADD COLUMN operation_confirmation text NOT NULL DEFAULT 'legacy'
    CHECK (operation_confirmation IN ('legacy','conversa','painel')),
  ADD COLUMN stock_operations_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN catalog_operations_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE network.dot_operation_reviews
  ADD COLUMN permission_domain text NOT NULL DEFAULT 'finance'
    CHECK (permission_domain IN ('finance','publisher','stock','catalog')),
  ADD COLUMN decision_channel text CHECK (decision_channel IN ('conversa','painel')),
  ADD COLUMN decided_at timestamptz;
COMMENT ON COLUMN network.dot_operation_reviews.decision_channel IS
  'conversa: declaração recebida pelo cliente autenticado; não representa biometria de voz.';
COMMIT;
