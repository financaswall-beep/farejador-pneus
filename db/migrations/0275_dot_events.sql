-- Private monitoring controls. No writes to commercial data or conversation payloads.
BEGIN;
CREATE TABLE network.dot_event_subscriptions (
  id text PRIMARY KEY CHECK (id ~ '^sub_[a-f0-9]{64}$'),
  environment env_t NOT NULL,
  person_id uuid NOT NULL REFERENCES network.partner_people(id),
  grant_id uuid NOT NULL REFERENCES network.dot_oauth_grants(id),
  activation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_name text NOT NULL CHECK (event_name IN ('farejador.conversa.atualizada','farejador.entrega.atencao')),
  arguments jsonb NOT NULL,
  callback_url text NOT NULL,
  secret_ciphertext text NOT NULL,
  previous_secret_ciphertext text,
  previous_secret_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NOT NULL DEFAULT now(),
  pending_nonce uuid,
  requested_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_delivery_at timestamptz,
  UNIQUE(environment,id)
);
CREATE INDEX dot_event_subscriptions_active ON network.dot_event_subscriptions(environment,event_name,expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE ops.dot_monitor_targets (
  environment env_t NOT NULL,
  kind text NOT NULL CHECK(kind IN ('conversation','order')),
  entity_id uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  first_dirty_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY(environment,kind,entity_id)
);
CREATE INDEX dot_monitor_due ON ops.dot_monitor_targets(environment,due_at) WHERE due_at IS NOT NULL;

CREATE TABLE ops.dot_event_deliveries (
  id text PRIMARY KEY CHECK(id ~ '^evt_[a-f0-9]{64}$'),
  environment env_t NOT NULL,
  subscription_id text NOT NULL,
  activation_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('conversation','order')),
  entity_id uuid NOT NULL,
  fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  not_before timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  FOREIGN KEY(environment,subscription_id) REFERENCES network.dot_event_subscriptions(environment,id) ON DELETE CASCADE,
  UNIQUE(environment,subscription_id,activation_id,kind,entity_id,fingerprint)
);
CREATE INDEX dot_event_delivery_pending ON ops.dot_event_deliveries(environment,not_before) WHERE status='pending';
CREATE INDEX dot_event_delivery_entity ON ops.dot_event_deliveries(environment,subscription_id,kind,entity_id,sent_at);

-- A tiny transactional queue only when a subscription exists. Worker does all analysis/delivery later.
CREATE FUNCTION ops.queue_dot_monitor_target() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,ops,network AS $$
DECLARE target_id uuid; target_kind text; target_event text;
BEGIN
  -- TG_TABLE_NAME is the physical monthly partition for messages. Use the trigger argument.
  IF TG_ARGV[0]='message' THEN
    IF NEW.is_private OR NEW.message_type NOT IN (0,1) THEN RETURN NEW; END IF;
    target_id:=NEW.conversation_id; target_kind:='conversation';
  ELSIF TG_ARGV[0]='conversation' THEN
    target_id:=NEW.id; target_kind:='conversation';
  ELSE
    target_id:=NEW.id; target_kind:='order';
  END IF;
  target_event:=CASE WHEN target_kind='conversation' THEN 'farejador.conversa.atualizada' ELSE 'farejador.entrega.atencao' END;
  IF NOT EXISTS(SELECT 1 FROM network.dot_event_subscriptions
    WHERE environment=NEW.environment AND event_name=target_event AND revoked_at IS NULL AND expires_at>now()) THEN
    RETURN NEW;
  END IF;
  INSERT INTO ops.dot_monitor_targets(environment,kind,entity_id,due_at)
    VALUES(NEW.environment,target_kind,target_id,now()+interval '90 seconds')
    ON CONFLICT(environment,kind,entity_id) DO UPDATE SET
      changed_at=now(),revision=ops.dot_monitor_targets.revision+1,
      first_dirty_at=CASE WHEN ops.dot_monitor_targets.due_at IS NULL THEN now() ELSE ops.dot_monitor_targets.first_dirty_at END,
      due_at=LEAST(now()+interval '90 seconds',
        CASE WHEN ops.dot_monitor_targets.due_at IS NULL THEN now() ELSE ops.dot_monitor_targets.first_dirty_at END+interval '5 minutes');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ops.queue_dot_monitor_target() FROM PUBLIC;
CREATE TRIGGER dot_monitor_message AFTER INSERT OR UPDATE OF content,status,deleted_at ON core.messages
  FOR EACH ROW EXECUTE FUNCTION ops.queue_dot_monitor_target('message');
CREATE TRIGGER dot_monitor_conversation AFTER INSERT OR UPDATE OF current_status,deleted_at ON core.conversations
  FOR EACH ROW EXECUTE FUNCTION ops.queue_dot_monitor_target('conversation');
CREATE TRIGGER dot_monitor_order AFTER INSERT OR UPDATE OF delivery_status,delivery_failure_reason,scheduled_delivery_date,status ON commerce.orders
  FOR EACH ROW EXECUTE FUNCTION ops.queue_dot_monitor_target('order');

CREATE TRIGGER dot_event_subscription_grant_env BEFORE INSERT OR UPDATE ON network.dot_event_subscriptions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','dot_oauth_grants','grant_id');
CREATE TRIGGER dot_event_subscription_person_env BEFORE INSERT OR UPDATE ON network.dot_event_subscriptions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('network','partner_people','person_id');
CREATE TRIGGER dot_event_subscription_env_immutable BEFORE UPDATE OF environment ON network.dot_event_subscriptions
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();
ALTER TABLE network.dot_event_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.dot_monitor_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.dot_event_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON network.dot_event_subscriptions,ops.dot_monitor_targets,ops.dot_event_deliveries FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','farejador_partner_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON network.dot_event_subscriptions,ops.dot_monitor_targets,ops.dot_event_deliveries FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
