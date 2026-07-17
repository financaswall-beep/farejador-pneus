-- 0139 — Etapa 6 / Fatia 6.4: comissão 2W nasce na realização e ganha filme imutável.

ALTER TABLE commerce.partner_orders
  ADD CONSTRAINT partner_orders_environment_id_uniq UNIQUE (environment, id);
ALTER TABLE network.partners
  ADD CONSTRAINT partners_environment_id_uniq UNIQUE (environment, id);
ALTER TABLE core.units
  ADD CONSTRAINT units_environment_id_uniq UNIQUE (environment, id);

ALTER TABLE network.commission_entries
  ADD COLUMN IF NOT EXISTS settlement_operation_key TEXT,
  ADD CONSTRAINT commission_entries_environment_identity_uniq
    UNIQUE (environment,id,partner_order_id);

-- Há legado de teste já estornado cuja venda foi apagada antes desta etapa. Ele é
-- evidência contábil, não lixo para a migration apagar. A restrição NOT VALID passa
-- a impedir qualquer órfão novo, sem fingir que o passado já era íntegro.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM network.commission_entries ce
    LEFT JOIN commerce.partner_orders po
      ON po.environment=ce.environment AND po.id=ce.partner_order_id
    WHERE po.id IS NULL AND ce.status<>'reversed'
  ) THEN
    RAISE EXCEPTION 'stage6_unresolved_commission_order_orphan';
  END IF;
END
$preflight$;

ALTER TABLE network.commission_entries
  ADD CONSTRAINT commission_entries_partner_order_fk
    FOREIGN KEY (environment, partner_order_id)
    REFERENCES commerce.partner_orders (environment, id) NOT VALID,
  ADD CONSTRAINT commission_entries_partner_fk
    FOREIGN KEY (environment, partner_id)
    REFERENCES network.partners (environment, id),
  ADD CONSTRAINT commission_entries_partner_unit_fk
    FOREIGN KEY (environment, partner_unit_id)
    REFERENCES network.partner_units (environment, id),
  ADD CONSTRAINT commission_entries_unit_fk
    FOREIGN KEY (environment, unit_id)
    REFERENCES core.units (environment, id);

ALTER TABLE commerce.orders
  ADD CONSTRAINT orders_partner_order_environment_fk
  FOREIGN KEY (environment, partner_order_id)
  REFERENCES commerce.partner_orders (environment, id);

CREATE UNIQUE INDEX IF NOT EXISTS orders_partner_order_causal_uniq
  ON commerce.orders (environment, partner_order_id)
  WHERE partner_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS network.commission_entry_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL,
  commission_entry_id UUID NOT NULL,
  partner_order_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created','settled','reversed')),
  previous_status TEXT,
  new_status TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  reason TEXT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commission_entry_events_cause_fk
    FOREIGN KEY (environment,commission_entry_id,partner_order_id)
    REFERENCES network.commission_entries(environment,id,partner_order_id),
  CONSTRAINT commission_entry_events_idempotency_uniq
    UNIQUE (environment, commission_entry_id, event_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS commission_entry_events_order_idx
  ON network.commission_entry_events(environment, partner_order_id, created_at);

CREATE OR REPLACE FUNCTION network.guard_commission_entry_financial_fact()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'commission_entry_financial_fact_immutable' USING ERRCODE='55000';
END;
$function$;

DROP TRIGGER IF EXISTS commission_entry_financial_fact_immutable
  ON network.commission_entries;
CREATE TRIGGER commission_entry_financial_fact_immutable
BEFORE UPDATE OF environment,partner_id,partner_unit_id,unit_id,partner_order_id,
  order_total,commission_percent,commission_amount,realized_at,created_at
ON network.commission_entries
FOR EACH ROW EXECUTE FUNCTION network.guard_commission_entry_financial_fact();

DROP TRIGGER IF EXISTS commission_entry_delete_immutable
  ON network.commission_entries;
CREATE TRIGGER commission_entry_delete_immutable
BEFORE DELETE ON network.commission_entries
FOR EACH ROW EXECUTE FUNCTION network.guard_commission_entry_financial_fact();

CREATE OR REPLACE FUNCTION network.guard_commission_entry_event_immutable()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'commission_entry_event_immutable' USING ERRCODE='55000';
END;
$function$;

DROP TRIGGER IF EXISTS commission_entry_events_immutable ON network.commission_entry_events;
CREATE TRIGGER commission_entry_events_immutable
BEFORE UPDATE OR DELETE ON network.commission_entry_events
FOR EACH ROW EXECUTE FUNCTION network.guard_commission_entry_event_immutable();

CREATE OR REPLACE FUNCTION network.record_partner_commission_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_realized BOOLEAN;
  v_was_realized BOOLEAN := false;
  v_partner_id UUID;
  v_partner_unit_id UUID;
  v_model TEXT;
  v_percent NUMERIC;
  v_base NUMERIC;
  v_realized_at TIMESTAMPTZ;
  v_entry_id UUID;
  v_entry RECORD;
BEGIN
  v_realized := NEW.status<>'cancelled' AND NEW.deleted_at IS NULL
    AND NOT (NEW.fulfillment_mode='delivery' AND NEW.delivery_status<>'delivered')
    AND NOT NEW.awaiting_pickup;
  IF TG_OP='UPDATE' THEN
    v_was_realized := OLD.status<>'cancelled' AND OLD.deleted_at IS NULL
      AND NOT (OLD.fulfillment_mode='delivery' AND OLD.delivery_status<>'delivered')
      AND NOT OLD.awaiting_pickup;
  END IF;

  IF NEW.source_tag='2w' AND v_realized AND NOT v_was_realized THEN
    SELECT pu.partner_id,pu.id,p.commercial_model,p.commission_percent
      INTO v_partner_id,v_partner_unit_id,v_model,v_percent
      FROM network.partner_units pu
      JOIN network.partners p ON p.id=pu.partner_id AND p.environment=pu.environment
     WHERE pu.environment=NEW.environment AND pu.unit_id=NEW.unit_id
       AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
     LIMIT 1;
    IF v_partner_id IS NOT NULL AND v_model IN ('commission','hybrid')
       AND COALESCE(v_percent,0)>0 THEN
      v_base := GREATEST(NEW.total_amount-COALESCE(NEW.freight_amount,0),0);
      v_realized_at := CASE WHEN NEW.fulfillment_mode='delivery'
        THEN COALESCE(NEW.delivered_at,now())
        ELSE COALESCE(NEW.retrieved_at,NEW.created_at,now()) END;
      INSERT INTO network.commission_entries
        (environment,partner_id,partner_unit_id,unit_id,partner_order_id,
         order_total,commission_percent,commission_amount,realized_at)
      VALUES
        (NEW.environment,v_partner_id,v_partner_unit_id,NEW.unit_id,NEW.id,
         v_base,v_percent,round(v_base*v_percent/100.0,2),v_realized_at)
      ON CONFLICT (environment,partner_order_id) DO NOTHING
      RETURNING id INTO v_entry_id;

      IF v_entry_id IS NOT NULL THEN
        INSERT INTO network.commission_entry_events
          (environment,commission_entry_id,partner_order_id,event_type,
           previous_status,new_status,actor_label,reason,idempotency_key,payload)
        VALUES
          (NEW.environment,v_entry_id,NEW.id,'created',NULL,'open',
           COALESCE('partner-token:'||NEW.operator_token_id::text,NEW.closed_by,
             'partner-order-trigger'),'venda 2W realizada',
           'commission-created-'||NEW.id::text,
           jsonb_build_object('order_total',v_base,'commission_percent',v_percent,
             'commission_amount',round(v_base*v_percent/100.0,2),
             'realized_at',v_realized_at));
      END IF;
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND NEW.status='cancelled' AND OLD.status<>'cancelled' THEN
    FOR v_entry IN
      SELECT id,status FROM network.commission_entries
       WHERE environment=NEW.environment AND partner_order_id=NEW.id
         AND status IN ('open','settled') FOR UPDATE
    LOOP
      UPDATE network.commission_entries
         SET status='reversed',reversed_at=now(),
             reversed_reason='venda cancelada/desfeita'
       WHERE id=v_entry.id;
      INSERT INTO network.commission_entry_events
        (environment,commission_entry_id,partner_order_id,event_type,
         previous_status,new_status,actor_label,reason,idempotency_key,payload)
      VALUES
        (NEW.environment,v_entry.id,NEW.id,'reversed',v_entry.status,'reversed',
         COALESCE(NULLIF(current_setting('app.partner_actor_label',true),''),
           'partner-order-trigger'),'venda cancelada/desfeita',
         'commission-reversed-'||NEW.id::text,
         jsonb_build_object('settlement_preserved',v_entry.status='settled'))
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION network.record_partner_commission_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION network.record_partner_commission_transition() FROM farejador_partner_app;

DROP TRIGGER IF EXISTS partner_order_commission_transition ON commerce.partner_orders;
CREATE TRIGGER partner_order_commission_transition
AFTER INSERT OR UPDATE OF status,delivery_status,delivered_at,awaiting_pickup,retrieved_at,deleted_at
ON commerce.partner_orders
FOR EACH ROW EXECUTE FUNCTION network.record_partner_commission_transition();

REVOKE ALL ON network.commission_entry_events FROM farejador_partner_app;
REVOKE ALL ON network.commission_entry_events FROM PUBLIC;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee='farejador_partner_app' AND table_schema='network'
       AND table_name IN ('commission_entries','commission_entry_events')
  ) THEN
    RAISE EXCEPTION 'stage6_partner_commission_grant_leak';
  END IF;
END
$verify$;

-- Rollback manual exige remover trigger/eventos/FKs antes das colunas.
