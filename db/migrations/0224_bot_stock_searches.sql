-- Observações determinísticas do estoque durante as buscas; sem mensagens/endereço do cliente.
CREATE TABLE ops.bot_stock_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  conversation_id uuid NOT NULL REFERENCES core.conversations(id),
  -- core.messages é particionada; a referência é validada com ambiente no trigger abaixo.
  trigger_message_id uuid,
  search_key text NOT NULL,
  tool_name text NOT NULL CHECK (tool_name IN ('buscar_produto','buscar_compatibilidade')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  measure text NOT NULL CHECK (length(measure) BETWEEN 1 AND 80),
  municipality text,
  filters jsonb NOT NULL DEFAULT '{}',
  stores jsonb NOT NULL CHECK (jsonb_typeof(stores) = 'array'),
  collector_version text NOT NULL DEFAULT 'stock_search_v1',
  UNIQUE(environment, search_key, measure)
);
CREATE INDEX bot_stock_searches_period ON ops.bot_stock_searches(environment, occurred_at DESC);
CREATE INDEX bot_stock_searches_measure ON ops.bot_stock_searches(environment, measure, occurred_at DESC);
CREATE FUNCTION ops.validate_stock_search_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.conversations c WHERE c.id=NEW.conversation_id AND c.environment=NEW.environment)
    OR (NEW.trigger_message_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM core.messages m WHERE m.id=NEW.trigger_message_id AND m.environment=NEW.environment
        AND m.conversation_id=NEW.conversation_id)) THEN
    RAISE EXCEPTION 'stock_search_environment_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bot_stock_searches_environment BEFORE INSERT ON ops.bot_stock_searches
FOR EACH ROW EXECUTE FUNCTION ops.validate_stock_search_environment();
CREATE TRIGGER bot_stock_searches_immutable BEFORE UPDATE OR DELETE ON ops.bot_stock_searches
FOR EACH ROW EXECUTE FUNCTION ops.guard_atendente_job_event_immutable();
ALTER TABLE ops.bot_stock_searches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.bot_stock_searches FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','farejador_partner_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ops.bot_stock_searches FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMENT ON TABLE ops.bot_stock_searches IS
'Estoque observado nas buscas do bot. Imutável, por ambiente; não reconstitui faltas antigas usando saldo atual.';
