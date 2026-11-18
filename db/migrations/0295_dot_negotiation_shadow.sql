BEGIN;

CREATE TABLE ops.dot_negotiation_shadow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  person_id uuid NOT NULL REFERENCES network.partner_people(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES core.contacts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL REFERENCES agent.turns(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES ops.dot_event_deliveries(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('manter','contrapropor','aceitar','aguardar_dado')),
  total_cents integer CHECK (total_cents > 0),
  fulfillment_mode text CHECK (fulfillment_mode IN ('entrega','retirada')),
  rationale text NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 300 AND length(rationale) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment,person_id,turn_id),
  CHECK ((total_cents IS NULL) = (fulfillment_mode IS NULL)),
  CHECK (decision NOT IN ('contrapropor','aceitar') OR total_cents IS NOT NULL),
  CHECK (decision <> 'aguardar_dado' OR total_cents IS NULL)
);
CREATE INDEX dot_negotiation_shadow_owner_history
  ON ops.dot_negotiation_shadow(environment,person_id,created_at DESC,id DESC);
CREATE INDEX dot_negotiation_shadow_turn ON ops.dot_negotiation_shadow(turn_id);
CREATE INDEX dot_negotiation_shadow_event ON ops.dot_negotiation_shadow(event_id);
CREATE INDEX dot_negotiation_shadow_contact ON ops.dot_negotiation_shadow(contact_id);

-- O descarte dos eventos enviados pelo monitor também descarta os pareceres derivados.
-- O contato interno é derivado da conversa para manter a exclusão em cascata mesmo depois
-- que a referência em core.conversations for anulada por uma exclusão física.
CREATE FUNCTION ops.guard_dot_negotiation_shadow() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scoped_contact uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT contact_id INTO scoped_contact FROM core.conversations
      WHERE id=NEW.conversation_id AND environment=NEW.environment;
    NEW.contact_id := scoped_contact;
    -- Só o parecer e o expurgo LGPD disputam esta chave. O atendimento não a utiliza.
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('dot-shadow-erasure:' || scoped_contact::text,0));
    IF NOT EXISTS (
      SELECT 1 FROM agent.turns t
      JOIN core.conversations c ON c.id=t.conversation_id AND c.environment=t.environment AND c.deleted_at IS NULL
      JOIN core.contacts ct ON ct.id=c.contact_id AND ct.environment=c.environment AND ct.deleted_at IS NULL
      JOIN ops.dot_event_deliveries d ON d.environment=t.environment
        AND d.entity_id=t.conversation_id AND d.id=NEW.event_id
      JOIN network.dot_event_subscriptions s ON s.environment=d.environment AND s.id=d.subscription_id
      JOIN network.partner_people p ON p.environment=s.environment AND p.id=s.person_id
      WHERE t.environment=NEW.environment AND t.id=NEW.turn_id AND t.conversation_id=NEW.conversation_id AND c.contact_id=scoped_contact
        AND d.kind='conversation' AND s.person_id=NEW.person_id
    ) THEN
      RAISE EXCEPTION 'dot_negotiation_shadow_origin_mismatch' USING ERRCODE='23503';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Apenas retenção ou remoção da origem elimina o parecer privado.
    IF NOT EXISTS (SELECT 1 FROM agent.turns WHERE id=OLD.turn_id)
       OR NOT EXISTS (SELECT 1 FROM network.partner_people WHERE id=OLD.person_id)
       OR NOT EXISTS (SELECT 1 FROM ops.dot_event_deliveries WHERE id=OLD.event_id)
       OR NOT EXISTS (SELECT 1 FROM core.contacts WHERE id=OLD.contact_id AND environment=OLD.environment AND deleted_at IS NULL) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'dot_negotiation_shadow_immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER dot_negotiation_shadow_guard BEFORE INSERT OR UPDATE OR DELETE
  ON ops.dot_negotiation_shadow FOR EACH ROW EXECUTE FUNCTION ops.guard_dot_negotiation_shadow();

CREATE FUNCTION ops.erase_dot_negotiation_shadow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('dot-shadow-erasure:' || NEW.contact_id::text,0));
  DELETE FROM ops.dot_negotiation_shadow n USING core.contacts ct
    WHERE ct.id=NEW.contact_id AND ct.environment=NEW.environment AND ct.deleted_at IS NOT NULL
      AND n.contact_id=ct.id AND n.environment=ct.environment;
  RETURN NULL;
END;
$$;
CREATE TRIGGER dot_negotiation_shadow_erasure AFTER INSERT ON ops.erasure_log
  FOR EACH ROW WHEN (NEW.contact_id IS NOT NULL) EXECUTE FUNCTION ops.erase_dot_negotiation_shadow();

ALTER TABLE ops.dot_negotiation_shadow ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.dot_negotiation_shadow FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.guard_dot_negotiation_shadow() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.erase_dot_negotiation_shadow() FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','farejador_partner_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ops.dot_negotiation_shadow FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
