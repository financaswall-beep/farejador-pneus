BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE commerce.matriz_stock_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  stock_id UUID,
  product_id UUID NOT NULL,
  model TEXT CHECK (length(btrim(model)) BETWEEN 1 AND 120),
  inspection_status TEXT NOT NULL CHECK (inspection_status IN ('located','pending','approved','blocked')),
  matched_set BOOLEAN NOT NULL DEFAULT false,
  CHECK (NOT matched_set OR (model IS NOT NULL AND inspection_status='approved')),
  conservation_note TEXT CHECK (length(conservation_note)<=500),
  conservation_grade TEXT CHECK (conservation_grade IN ('selecionado','economico')),
  CHECK (conservation_grade IS NULL OR inspection_status='approved'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
  conferred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(environment,id),
  UNIQUE(environment,id,product_id),
  FOREIGN KEY(environment,stock_id) REFERENCES commerce.wholesale_stock(environment,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(environment,product_id) REFERENCES commerce.products(environment,id) ON DELETE RESTRICT
);
CREATE INDEX matriz_stock_groups_stock_idx ON commerce.matriz_stock_groups(environment,stock_id);
CREATE INDEX matriz_stock_groups_product_idx ON commerce.matriz_stock_groups(environment,product_id);

CREATE TABLE commerce.matriz_stock_group_positions (
  environment env_t NOT NULL,
  group_id UUID NOT NULL,
  location_code TEXT NOT NULL CHECK (length(location_code) BETWEEN 1 AND 60 AND location_code=btrim(location_code)),
  quantity_on_hand INTEGER NOT NULL CHECK (quantity_on_hand>=0),
  quantity_reserved INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved BETWEEN 0 AND quantity_on_hand),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,group_id,location_code),
  FOREIGN KEY(environment,group_id) REFERENCES commerce.matriz_stock_groups(environment,id) ON DELETE RESTRICT
);

CREATE TABLE commerce.matriz_stock_group_allocations (
  environment env_t NOT NULL,
  order_id UUID NOT NULL,
  group_id UUID NOT NULL,
  product_id UUID NOT NULL,
  location_code TEXT NOT NULL,
  model TEXT,
  quantity INTEGER NOT NULL CHECK(quantity>0),
  specific_offer BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL CHECK(status IN ('reserved','consumed','released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  CHECK ((status='reserved')=(finalized_at IS NULL)),
  PRIMARY KEY(environment,order_id,group_id,location_code),
  FOREIGN KEY(environment,order_id) REFERENCES commerce.orders(environment,id) ON DELETE RESTRICT,
  FOREIGN KEY(environment,group_id,product_id) REFERENCES commerce.matriz_stock_groups(environment,id,product_id),
  FOREIGN KEY(environment,group_id,location_code) REFERENCES commerce.matriz_stock_group_positions(environment,group_id,location_code)
);
CREATE INDEX matriz_stock_group_allocations_position_idx ON commerce.matriz_stock_group_allocations
  (environment,group_id,location_code) WHERE status='reserved';

CREATE TABLE commerce.matriz_stock_group_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  group_id UUID NOT NULL,
  order_id UUID,
  reference TEXT,
  movement_type TEXT NOT NULL CHECK(movement_type IN ('inspect','move','reserve','release','consume','return')),
  from_location TEXT,
  to_location TEXT,
  quantity INTEGER CHECK(quantity>0),
  reason TEXT,
  actor_label TEXT,
  detail JSONB,
  reverses_movement_id UUID REFERENCES commerce.matriz_stock_group_movements(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(environment,group_id) REFERENCES commerce.matriz_stock_groups(environment,id),
  FOREIGN KEY(environment,order_id) REFERENCES commerce.orders(environment,id) ON DELETE RESTRICT
);
CREATE INDEX matriz_stock_group_movements_group_idx ON commerce.matriz_stock_group_movements(environment,group_id,created_at DESC);
CREATE INDEX matriz_stock_group_movements_reference_idx ON commerce.matriz_stock_group_movements(environment,reference,movement_type)
  WHERE reference IS NOT NULL;
CREATE INDEX matriz_stock_group_movements_reversal_idx ON commerce.matriz_stock_group_movements(reverses_movement_id)
  WHERE reverses_movement_id IS NOT NULL;
CREATE TRIGGER matriz_stock_group_movements_immutable BEFORE UPDATE OR DELETE ON commerce.matriz_stock_group_movements
  FOR EACH ROW EXECUTE FUNCTION commerce.preserve_tire_lot_movement();

CREATE FUNCTION commerce.matriz_stock_group_model_matches(group_model TEXT,catalog_model TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT NULLIF(btrim(catalog_model),'') IS NULL OR NULLIF(btrim(group_model),'') IS NULL
    OR lower(regexp_replace(btrim(group_model),'[[:space:]]+',' ','g'))=
       lower(regexp_replace(btrim(catalog_model),'[[:space:]]+',' ','g'))
$$;

CREATE FUNCTION commerce.matriz_stock_inspection_unavailable(env_t,UUID) RETURNS INTEGER
LANGUAGE sql STABLE SET search_path=pg_catalog,commerce AS $$
  SELECT COALESCE(sum(p.quantity_on_hand-p.quantity_reserved),0)::int
  FROM commerce.matriz_stock_groups g JOIN commerce.matriz_stock_group_positions p
    ON p.environment=g.environment AND p.group_id=g.id
  WHERE g.environment=$1 AND g.stock_id=$2 AND (g.inspection_status IN ('pending','blocked') OR EXISTS(
    SELECT 1 FROM commerce.tire_specs ts WHERE ts.environment=g.environment AND ts.product_id=g.product_id
      AND NOT commerce.matriz_stock_group_model_matches(g.model,ts.tread_pattern)
  ))
$$;

-- Saldo de grupo faz parte da variante oficial. Operações genéricas só podem usar a parte livre fora de grupos.
CREATE FUNCTION commerce.assert_matriz_stock_group_totals(env_t,UUID,INTEGER,INTEGER) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
DECLARE grouped BIGINT; reserved BIGINT;
BEGIN
  SELECT COALESCE(sum(p.quantity_on_hand),0),COALESCE(sum(p.quantity_reserved),0) INTO grouped,reserved
  FROM commerce.matriz_stock_groups g
  JOIN commerce.matriz_stock_group_positions p ON p.environment=g.environment AND p.group_id=g.id
  WHERE g.environment=$1 AND g.stock_id=$2;
  IF grouped-reserved>$3-$4 OR reserved>$4 THEN RAISE EXCEPTION 'stock_group_protected'; END IF;
END $$;

CREATE FUNCTION commerce.protect_matriz_stock_groups() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
DECLARE
  source TEXT := COALESCE(current_setting('app.galpao_source',true),'');
  ref TEXT := NULLIF(current_setting('app.galpao_ref',true),'');
  sale_order UUID; reverse_ref TEXT; reverse_source TEXT;
  location RECORD; needed INTEGER; units INTEGER; ordered INTEGER;
BEGIN
  IF NEW.quantity_on_hand < OLD.quantity_on_hand AND NEW.quantity_reserved = OLD.quantity_reserved THEN
    -- Avulsa, atacado e inventário usam primeiro o saldo fora dos grupos. Ao entrar
    -- em um grupo, somente unidades livres saem e gravamos a pilha exata.
    SELECT GREATEST(COALESCE(sum(p.quantity_on_hand-p.quantity_reserved),0)
      -(NEW.quantity_on_hand-NEW.quantity_reserved),0)::int INTO needed
    FROM commerce.matriz_stock_groups g JOIN commerce.matriz_stock_group_positions p
      ON p.environment=g.environment AND p.group_id=g.id
    WHERE g.environment=OLD.environment AND g.stock_id=OLD.id;
    IF needed>0 THEN
      IF ref ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN
        SELECT o.id INTO sale_order FROM commerce.orders o WHERE o.environment=OLD.environment AND o.id=ref::uuid;
      END IF;
      FOR location IN SELECT p.group_id,p.location_code,p.quantity_on_hand-p.quantity_reserved AS available,g.product_id,g.model
        FROM commerce.matriz_stock_groups g JOIN commerce.matriz_stock_group_positions p
          ON p.environment=g.environment AND p.group_id=g.id
        WHERE g.environment=OLD.environment AND g.stock_id=OLD.id AND p.quantity_on_hand>p.quantity_reserved
          AND (sale_order IS NULL OR EXISTS(SELECT 1 FROM commerce.order_items i
            WHERE i.environment=g.environment AND i.order_id=sale_order AND i.product_id=g.product_id))
          AND (source IN ('definir','baixa_manual','cancelamento_compra','estorno_transferencia_lote') OR (
            g.inspection_status IN ('located','approved') AND NOT EXISTS(
              SELECT 1 FROM commerce.tire_specs ts WHERE ts.environment=g.environment AND ts.product_id=g.product_id
              AND NOT commerce.matriz_stock_group_model_matches(g.model,ts.tread_pattern)
            )
          ))
        ORDER BY (g.inspection_status IN ('located','approved')),g.matched_set,g.id,p.location_code
      LOOP
        units:=LEAST(needed,location.available);
        IF sale_order IS NOT NULL THEN
          SELECT (COALESCE(sum(i.quantity),0)-COALESCE((SELECT sum(a.quantity) FROM commerce.matriz_stock_group_allocations a
            WHERE a.environment=OLD.environment AND a.order_id=sale_order AND a.product_id=location.product_id
              AND a.status IN ('reserved','consumed')),0))::int INTO ordered
          FROM commerce.order_items i WHERE i.environment=OLD.environment AND i.order_id=sale_order AND i.product_id=location.product_id;
          units:=LEAST(units,ordered);
        END IF;
        IF units<=0 THEN CONTINUE; END IF;
        UPDATE commerce.matriz_stock_group_positions SET quantity_on_hand=quantity_on_hand-units
          WHERE environment=OLD.environment AND group_id=location.group_id AND location_code=location.location_code;
        INSERT INTO commerce.matriz_stock_group_movements(environment,group_id,order_id,reference,movement_type,
          from_location,quantity,reason,detail)
        VALUES (OLD.environment,location.group_id,sale_order,ref,'consume',location.location_code,units,
          NULLIF(current_setting('app.galpao_reason',true),''),jsonb_build_object('source',source));
        IF sale_order IS NOT NULL THEN
          INSERT INTO commerce.matriz_stock_group_allocations(environment,order_id,group_id,product_id,location_code,model,quantity,status,finalized_at)
          VALUES (OLD.environment,sale_order,location.group_id,location.product_id,location.location_code,
            location.model,units,'consumed',clock_timestamp());
        END IF;
        needed:=needed-units;
        EXIT WHEN needed=0;
      END LOOP;
    END IF;
  ELSIF NEW.quantity_on_hand>OLD.quantity_on_hand AND ref IS NOT NULL THEN
    reverse_ref:=ref;
    IF source='cancelamento_varejo' THEN reverse_source:='varejo';
    ELSIF source='cancelamento_venda' THEN reverse_source:='venda_atacado';
    ELSIF source='estorno_transferencia_lote' AND ref ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN
      reverse_source:='transferencia_lote';
      SELECT t.reversal_of::text INTO reverse_ref FROM commerce.tire_stock_transfers t
        WHERE t.environment=OLD.environment AND t.id=ref::uuid;
    END IF;
    IF reverse_source IS NOT NULL AND reverse_ref IS NOT NULL THEN
      needed:=NEW.quantity_on_hand-OLD.quantity_on_hand;
      FOR location IN SELECT m.id,m.group_id,m.order_id,m.from_location,
          (m.quantity-COALESCE((SELECT sum(r.quantity) FROM commerce.matriz_stock_group_movements r
            WHERE r.reverses_movement_id=m.id),0))::int restorable
        FROM commerce.matriz_stock_group_movements m JOIN commerce.matriz_stock_groups g
          ON g.environment=m.environment AND g.id=m.group_id
        WHERE m.environment=OLD.environment AND g.stock_id=OLD.id AND m.movement_type='consume'
          AND m.reference=reverse_ref AND m.detail->>'source'=reverse_source
        ORDER BY m.created_at,m.id
      LOOP
        units:=LEAST(needed,location.restorable);
        IF units<=0 THEN CONTINUE; END IF;
        UPDATE commerce.matriz_stock_group_positions SET quantity_on_hand=quantity_on_hand+units
          WHERE environment=OLD.environment AND group_id=location.group_id AND location_code=location.from_location;
        INSERT INTO commerce.matriz_stock_group_movements(environment,group_id,order_id,reference,movement_type,
          to_location,quantity,reverses_movement_id,detail)
        VALUES (OLD.environment,location.group_id,location.order_id,ref,'return',location.from_location,
          units,location.id,jsonb_build_object('source',source));
        IF location.order_id IS NOT NULL AND units=location.restorable THEN
          UPDATE commerce.matriz_stock_group_allocations SET status='released',finalized_at=clock_timestamp()
            WHERE environment=OLD.environment AND order_id=location.order_id AND group_id=location.group_id
              AND location_code=location.from_location AND status='consumed';
        END IF;
        needed:=needed-units;
        EXIT WHEN needed=0;
      END LOOP;
    END IF;
  END IF;
  IF NEW.quantity_on_hand IS DISTINCT FROM OLD.quantity_on_hand OR NEW.quantity_reserved IS DISTINCT FROM OLD.quantity_reserved THEN
    PERFORM commerce.assert_matriz_stock_group_totals(NEW.environment,NEW.id,NEW.quantity_on_hand,NEW.quantity_reserved);
  END IF;
  IF (NEW.measure,NEW.brand,NEW.tire_condition) IS DISTINCT FROM (OLD.measure,OLD.brand,OLD.tire_condition)
    AND EXISTS (SELECT 1 FROM commerce.matriz_stock_groups g
      JOIN commerce.matriz_stock_group_positions p ON p.environment=g.environment AND p.group_id=g.id
      WHERE g.environment=OLD.environment AND g.stock_id=OLD.id AND p.quantity_on_hand>0)
  THEN RAISE EXCEPTION 'stock_group_protected'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_matriz_stock_groups BEFORE UPDATE ON commerce.wholesale_stock
  FOR EACH ROW EXECUTE FUNCTION commerce.protect_matriz_stock_groups();

CREATE FUNCTION commerce.detach_empty_matriz_stock_groups() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
BEGIN
  -- A correção recria a mesma variante e o mesmo ID dentro da transação.
  IF current_setting('app.galpao_source',true)='correcao_marca' THEN RETURN OLD; END IF;
  IF EXISTS(SELECT 1 FROM commerce.matriz_stock_groups g JOIN commerce.matriz_stock_group_positions p
    ON p.environment=g.environment AND p.group_id=g.id
    WHERE g.environment=OLD.environment AND g.stock_id=OLD.id AND p.quantity_on_hand>0)
  THEN RAISE EXCEPTION 'stock_group_protected'; END IF;
  UPDATE commerce.matriz_stock_groups SET stock_id=NULL,revision=revision+1,updated_at=clock_timestamp()
    WHERE environment=OLD.environment AND stock_id=OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER detach_empty_matriz_stock_groups BEFORE DELETE ON commerce.wholesale_stock
  FOR EACH ROW EXECUTE FUNCTION commerce.detach_empty_matriz_stock_groups();

-- Um único lock de saldo por variante serializa conferência, movimento, venda avulsa e reserva.
CREATE FUNCTION commerce.lock_matriz_stock_group_position() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.environment,NEW.group_id,NEW.location_code) IS DISTINCT FROM (OLD.environment,OLD.group_id,OLD.location_code)
  THEN RAISE EXCEPTION 'stock_group_position_immutable'; END IF;
  PERFORM 1 FROM commerce.wholesale_stock s JOIN commerce.matriz_stock_groups g
    ON g.environment=s.environment AND g.stock_id=s.id
    WHERE g.environment=NEW.environment AND g.id=NEW.group_id FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock_group_not_found'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lock_matriz_stock_group_position BEFORE INSERT OR UPDATE ON commerce.matriz_stock_group_positions
  FOR EACH ROW EXECUTE FUNCTION commerce.lock_matriz_stock_group_position();

CREATE FUNCTION commerce.check_matriz_stock_group_position() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,commerce AS $$
DECLARE sid UUID; physical INTEGER; reserved INTEGER; position_reserved INTEGER; assigned BIGINT;
BEGIN
  SELECT s.id,s.quantity_on_hand,s.quantity_reserved INTO sid,physical,reserved
    FROM commerce.wholesale_stock s JOIN commerce.matriz_stock_groups g ON g.environment=s.environment AND g.stock_id=s.id
    WHERE g.environment=NEW.environment AND g.id=NEW.group_id;
  PERFORM commerce.assert_matriz_stock_group_totals(NEW.environment,sid,physical,reserved);
  SELECT p.quantity_reserved INTO position_reserved FROM commerce.matriz_stock_group_positions p
    WHERE p.environment=NEW.environment AND p.group_id=NEW.group_id AND p.location_code=NEW.location_code;
  SELECT COALESCE(sum(a.quantity),0) INTO assigned FROM commerce.matriz_stock_group_allocations a
    WHERE a.environment=NEW.environment AND a.group_id=NEW.group_id AND a.location_code=NEW.location_code AND a.status='reserved';
  IF position_reserved IS DISTINCT FROM assigned THEN RAISE EXCEPTION 'stock_group_reservation_mismatch'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER check_matriz_stock_group_position AFTER INSERT OR UPDATE ON commerce.matriz_stock_group_positions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.check_matriz_stock_group_position();
CREATE CONSTRAINT TRIGGER check_matriz_stock_group_allocation AFTER INSERT OR UPDATE ON commerce.matriz_stock_group_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.check_matriz_stock_group_position();

ALTER TABLE commerce.matriz_stock_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.matriz_stock_group_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.matriz_stock_group_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.matriz_stock_group_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.matriz_stock_groups,commerce.matriz_stock_group_positions,
  commerce.matriz_stock_group_allocations,commerce.matriz_stock_group_movements FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.matriz_stock_inspection_unavailable(env_t,UUID),
  commerce.assert_matriz_stock_group_totals(env_t,UUID,INTEGER,INTEGER),
  commerce.protect_matriz_stock_groups(),commerce.lock_matriz_stock_group_position(),
  commerce.check_matriz_stock_group_position(),commerce.detach_empty_matriz_stock_groups() FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','partner_app','farejador_partner_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON commerce.matriz_stock_groups,commerce.matriz_stock_group_positions,commerce.matriz_stock_group_allocations,commerce.matriz_stock_group_movements FROM %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
