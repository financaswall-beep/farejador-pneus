-- Confirmação física do parceiro antes da promessa do bot. Matriz não participa.
-- A fila não reserva estoque: a reserva continua no fechamento existente do pedido.
CREATE TABLE commerce.partner_stock_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment public.env_t NOT NULL,
  conversation_id uuid NOT NULL REFERENCES core.conversations(id),
  request_message_id uuid,
  unit_id uuid NOT NULL REFERENCES core.units(id),
  basket_key text NOT NULL,
  items jsonb NOT NULL CHECK (jsonb_typeof(items)='array' AND jsonb_array_length(items)>0),
  routing jsonb NOT NULL,
  closing_args jsonb,
  excluded_unit_ids uuid[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  sealed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','confirmed','rejected','expired','cancelled','exhausted','matrix','completed')),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  valid_until timestamptz,
  answered_at timestamptz,
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partner_stock_requests_one_pending
  ON commerce.partner_stock_requests(environment,conversation_id) WHERE status='pending';
CREATE INDEX partner_stock_requests_queue
  ON commerce.partner_stock_requests(environment,unit_id,expires_at) WHERE status='pending';
CREATE INDEX partner_stock_requests_worker
  ON commerce.partner_stock_requests(environment,updated_at) WHERE notified_at IS NULL;
CREATE TRIGGER stock_request_environment_immutable BEFORE UPDATE OF environment
  ON commerce.partner_stock_requests FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
CREATE TRIGGER stock_request_conversation_environment BEFORE INSERT OR UPDATE OF environment,conversation_id
  ON commerce.partner_stock_requests FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','conversations','conversation_id');
CREATE TRIGGER stock_request_unit_environment BEFORE INSERT OR UPDATE OF environment,unit_id
  ON commerce.partner_stock_requests FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','units','unit_id');
CREATE TRIGGER stock_request_updated_at BEFORE UPDATE ON commerce.partner_stock_requests
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();
ALTER TABLE commerce.partner_stock_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_request_unit_isolation ON commerce.partner_stock_requests FOR SELECT
  USING (unit_id=network.current_partner_core_unit());
-- Whitelist física: parceiro não lê conversa, contato, SKU interno, endereço ou argumentos do bot.
REVOKE ALL ON commerce.partner_stock_requests FROM PUBLIC,farejador_partner_app;
GRANT SELECT(id,environment,unit_id,items,revision,status,sealed,expires_at,created_at)
  ON commerce.partner_stock_requests TO farejador_partner_app;

CREATE FUNCTION commerce.answer_partner_stock_request(p_id uuid,p_revision integer,p_available boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,commerce,network,pg_temp AS $$
DECLARE r commerce.partner_stock_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM commerce.partner_stock_requests
    WHERE id=p_id AND unit_id=network.current_partner_core_unit() FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF r.revision<>p_revision OR NOT r.sealed THEN RETURN 'changed'; END IF;
  IF r.status<>'pending' THEN RETURN r.status; END IF;
  IF r.expires_at<=now() THEN
    UPDATE commerce.partner_stock_requests SET status='expired' WHERE id=r.id;
    RETURN 'expired';
  END IF;
  UPDATE commerce.partner_stock_requests SET
    status=CASE WHEN p_available THEN 'confirmed' ELSE 'rejected' END,
    answered_at=now(),valid_until=CASE WHEN p_available THEN now()+interval '10 minutes' END
    WHERE id=r.id;
  RETURN CASE WHEN p_available THEN 'confirmed' ELSE 'rejected' END;
END $$;
REVOKE ALL ON FUNCTION commerce.answer_partner_stock_request(uuid,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.answer_partner_stock_request(uuid,integer,boolean) TO farejador_partner_app;

ALTER TABLE ops.outbound_messages DROP CONSTRAINT outbound_messages_kind_check;
ALTER TABLE ops.outbound_messages ADD CONSTRAINT outbound_messages_kind_check CHECK(kind IN
  ('agent_text','survey_text','photo_text','photo_attachment','conversation_resolution',
   'operator_text','operator_attachment','stock_text'));
