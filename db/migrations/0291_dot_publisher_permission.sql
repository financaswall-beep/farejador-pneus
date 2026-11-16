-- A autorização de escrita do publicador pertence à conexão do proprietário.
ALTER TABLE network.dot_oauth_grants
  ADD COLUMN publisher_enabled boolean NOT NULL DEFAULT false;
