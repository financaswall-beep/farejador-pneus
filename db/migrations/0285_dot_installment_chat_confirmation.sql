BEGIN;
ALTER TABLE network.dot_oauth_grants
  ADD COLUMN installment_chat_confirmation boolean NOT NULL DEFAULT false;
COMMIT;
