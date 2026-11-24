BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE commerce.matriz_stock_origins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  stock_id uuid NOT NULL,
  reference_id uuid NOT NULL,
  source text NOT NULL CHECK(source IN ('varejo','venda_atacado')),
  product_id uuid,
  quantity int NOT NULL CHECK(quantity>0),
  variant_quantity int NOT NULL CHECK(variant_quantity>=quantity),
  phase text NOT NULL CHECK(phase IN ('reserved','consumed')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled')),
  snapshot_ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  actor_label text,
  UNIQUE(environment,id),
  FOREIGN KEY(environment,product_id) REFERENCES commerce.products(environment,id)
);
-- stock_id e reference_id preservam a identificação da venda mesmo após encerrar o estoque.
CREATE INDEX matriz_stock_origins_open ON commerce.matriz_stock_origins(environment,stock_id,id) WHERE status='pending';
CREATE INDEX matriz_stock_origins_reference ON commerce.matriz_stock_origins(environment,reference_id,source);
CREATE UNIQUE INDEX matriz_stock_origins_live ON commerce.matriz_stock_origins
 (environment,reference_id,source,stock_id,product_id) NULLS NOT DISTINCT WHERE status<>'cancelled';

CREATE TABLE commerce.matriz_stock_origin_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  origin_id uuid NOT NULL,
  group_id uuid,
  location_code text,
  model text,
  matched_set boolean NOT NULL,
  capacity int NOT NULL CHECK(capacity>0),
  suggested_quantity int NOT NULL DEFAULT 0 CHECK(suggested_quantity BETWEEN 0 AND capacity),
  confirmed_quantity int CHECK(confirmed_quantity BETWEEN 0 AND capacity),
  CHECK((group_id IS NULL)=(location_code IS NULL)),
  FOREIGN KEY(environment,origin_id) REFERENCES commerce.matriz_stock_origins(environment,id),
  FOREIGN KEY(environment,group_id,location_code) REFERENCES commerce.matriz_stock_group_positions(environment,group_id,location_code),
  UNIQUE NULLS NOT DISTINCT(environment,origin_id,group_id,location_code)
);
CREATE INDEX matriz_stock_origin_candidates_group ON commerce.matriz_stock_origin_candidates(environment,group_id,origin_id);

CREATE FUNCTION commerce.matriz_stock_origin_candidate_pending(env env_t,gid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,commerce AS $$
  SELECT EXISTS(SELECT 1 FROM commerce.matriz_stock_origin_candidates c JOIN commerce.matriz_stock_origins p
    ON p.environment=c.environment AND p.id=c.origin_id WHERE c.environment=env AND c.group_id=gid AND p.status='pending')
$$;
CREATE FUNCTION commerce.matriz_stock_origin_uncertain(env env_t,gid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,commerce AS $$
  SELECT commerce.matriz_stock_origin_candidate_pending(env,gid)
$$;

CREATE FUNCTION commerce.matriz_stock_active_set(env env_t,gid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,commerce AS $$
  SELECT EXISTS(SELECT 1 FROM commerce.matriz_stock_groups g JOIN commerce.matriz_stock_group_positions p
    ON p.environment=g.environment AND p.group_id=g.id WHERE g.environment=env AND g.id=gid AND g.matched_set
    GROUP BY g.id HAVING sum(p.quantity_on_hand-p.quantity_reserved)>=2)
$$;

-- Uma peça remanescente de um conjunto antigo disputa a venda como avulsa.
-- O restante do trigger continua executando as mesmas regras da migration 0302.
DO $$ DECLARE body text; previous text:='g.matched_set,g.id,p.location_code';
BEGIN
  SELECT pg_get_functiondef('commerce.protect_matriz_stock_groups()'::regprocedure) INTO body;
  IF position(previous IN body)=0 THEN RAISE EXCEPTION 'stock_origin_previous_allocation_function_mismatch'; END IF;
  EXECUTE replace(body,previous,'commerce.matriz_stock_active_set(g.environment,g.id),g.id,p.location_code');
END $$;

-- Restaura apenas para cálculo as alocações provisórias. Uma sugestão consumida pela
-- primeira venda ainda pode ter sido a peça fisicamente retirada pela segunda.
-- Para registrar uma nova saída, exigimos cadastro e modelo compatíveis naquele momento.
-- Uma conferência posterior usa os candidatos salvos e só consulta sua capacidade física.
CREATE FUNCTION commerce.matriz_stock_origin_supply(env env_t,sid uuid,eligible_only boolean DEFAULT true)
RETURNS TABLE(group_id uuid,location_code text,product_id uuid,model text,matched_set boolean,capacity int)
LANGUAGE sql STABLE SET search_path=pg_catalog,commerce AS $$
  WITH provisional AS (
    SELECT c.group_id,c.location_code,sum(c.suggested_quantity)::int qty
    FROM commerce.matriz_stock_origins p JOIN commerce.matriz_stock_origin_candidates c
      ON c.environment=p.environment AND c.origin_id=p.id
    WHERE p.environment=env AND p.stock_id=sid AND p.status='pending' AND p.snapshot_ready
    GROUP BY c.group_id,c.location_code
  ), positions AS (
    SELECT g.id,g.product_id,g.model,g.matched_set,g.inspection_status,p.location_code,p.quantity_on_hand-p.quantity_reserved free,
      ts.vehicle_type,ts.tread_pattern,pr.deleted_at,pr.partner_generic,
      commerce.catalog_brand_identity(pr.brand)=commerce.catalog_brand_identity(s.brand) AND
      regexp_replace(ts.tire_size,'[^0-9]','','g')=regexp_replace(s.measure,'[^0-9]','','g')
        AND pr.tire_condition=s.tire_condition AS same_variant
    FROM commerce.matriz_stock_groups g JOIN commerce.matriz_stock_group_positions p
      ON p.environment=g.environment AND p.group_id=g.id
    JOIN commerce.wholesale_stock s ON s.environment=g.environment AND s.id=g.stock_id
    LEFT JOIN commerce.products pr ON pr.environment=g.environment AND pr.id=g.product_id
    LEFT JOIN commerce.tire_specs ts ON ts.environment=g.environment AND ts.product_id=g.product_id
    WHERE g.environment=env AND g.stock_id=sid
  )
  SELECT x.id,x.location_code,x.product_id,x.model,
    x.matched_set AND sum(x.free+coalesce(v.qty,0)) OVER(PARTITION BY x.id)>=2,x.free+coalesce(v.qty,0)
  FROM positions x LEFT JOIN provisional v ON v.group_id=x.id AND v.location_code=x.location_code
  WHERE (NOT eligible_only OR (x.inspection_status IN ('located','approved') AND x.vehicle_type='car' AND x.same_variant
    AND x.deleted_at IS NULL AND NOT x.partner_generic AND commerce.matriz_stock_group_model_matches(x.model,x.tread_pattern)))
    AND x.free+coalesce(v.qty,0)>0
  UNION ALL
  SELECT NULL::uuid,NULL::text,NULL::uuid,NULL::text,false,
    (s.quantity_on_hand-s.quantity_reserved-coalesce((SELECT sum(x.free) FROM positions x),0)
     +coalesce((SELECT qty FROM provisional WHERE provisional.group_id IS NULL),0))::int
  FROM commerce.wholesale_stock s WHERE s.environment=env AND s.id=sid
$$;

CREATE FUNCTION commerce.capture_matriz_stock_origin(env env_t,sid uuid,ref uuid,mode text,units int,demand jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,commerce AS $$
DECLARE item record; options jsonb; oid uuid; channel text;
BEGIN
  IF units<=0 OR NOT EXISTS(SELECT 1 FROM commerce.matriz_stock_groups WHERE environment=env AND stock_id=sid AND matched_set)
    THEN RETURN; END IF;
  channel:=CASE WHEN mode='venda_atacado' THEN mode ELSE 'varejo' END;
  IF mode='venda_atacado' THEN
    IF NOT EXISTS(SELECT 1 FROM commerce.wholesale_orders WHERE environment=env AND id=ref) THEN RETURN; END IF;
    demand:=jsonb_build_array(jsonb_build_object('product_id',NULL,'quantity',units));
  ELSIF demand IS NULL THEN
    SELECT jsonb_agg(jsonb_build_object('product_id',i.product_id,'quantity',i.quantity)) INTO demand
      FROM commerce.order_items i WHERE i.environment=env AND i.order_id=ref;
  END IF;
  FOR item IN SELECT d.product_id,sum(d.quantity)::int qty FROM jsonb_to_recordset(demand) AS d(product_id uuid,quantity int)
    WHERE d.quantity>0 AND (d.product_id IS NULL OR EXISTS(SELECT 1 FROM commerce.matriz_stock_groups g
      WHERE g.environment=env AND g.stock_id=sid AND g.product_id=d.product_id AND g.matched_set))
    GROUP BY d.product_id
  LOOP
    IF EXISTS(SELECT 1 FROM commerce.matriz_stock_origins WHERE environment=env AND reference_id=ref AND source=channel
      AND stock_id=sid AND product_id IS NOT DISTINCT FROM item.product_id AND status<>'cancelled') THEN CONTINUE; END IF;
    SELECT jsonb_agg(to_jsonb(s)) INTO options FROM commerce.matriz_stock_origin_supply(env,sid) s
      WHERE s.capacity>0 AND (item.product_id IS NULL OR s.product_id IS NULL OR s.product_id=item.product_id);
    -- Só pergunta se existir um conjunto de 2+ vendáveis, uma origem alternativa e
    -- se o total do pedido não consumir forçosamente todas as alternativas.
    IF options IS NULL OR NOT EXISTS(
      WITH opts AS (SELECT * FROM jsonb_to_recordset(options) AS x(group_id uuid,matched_set boolean,capacity int)),
      totals AS (SELECT group_id,bool_or(matched_set) matched,sum(capacity) qty FROM opts GROUP BY group_id)
      SELECT 1 FROM totals WHERE matched AND qty>=2 AND qty<(SELECT sum(qty) FROM totals)
        AND item.qty<(SELECT sum(qty) FROM totals)
    ) THEN CONTINUE; END IF;
    INSERT INTO commerce.matriz_stock_origins(environment,stock_id,reference_id,source,product_id,quantity,variant_quantity,phase)
      VALUES(env,sid,ref,channel,item.product_id,item.qty,units,CASE WHEN mode='reservation' THEN 'reserved' ELSE 'consumed' END)
      RETURNING id INTO oid;
    INSERT INTO commerce.matriz_stock_origin_candidates(environment,origin_id,group_id,location_code,model,matched_set,capacity)
      SELECT env,oid,x.group_id,x.location_code,x.model,x.matched_set,x.capacity FROM jsonb_to_recordset(options)
        AS x(group_id uuid,location_code text,model text,matched_set boolean,capacity int);
  END LOOP;
END $$;

CREATE FUNCTION commerce.snapshot_matriz_stock_origin(env env_t,sid uuid,ref uuid,mode text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,commerce AS $$
DECLARE p record; loose int; fresh_ids uuid[]:='{}'; channel text:=CASE WHEN mode='venda_atacado' THEN mode ELSE 'varejo' END;
BEGIN
  FOR p IN SELECT * FROM commerce.matriz_stock_origins WHERE environment=env AND stock_id=sid
    AND reference_id=ref AND source=channel AND status='pending' AND NOT snapshot_ready
  LOOP
    UPDATE commerce.matriz_stock_origin_candidates c SET suggested_quantity=CASE WHEN channel='varejo'
      THEN coalesce((SELECT a.quantity FROM commerce.matriz_stock_group_allocations a WHERE a.environment=env
        AND a.order_id=ref AND a.group_id=c.group_id AND a.location_code=c.location_code AND a.status=p.phase),0)
      ELSE coalesce((SELECT sum(m.quantity) FROM commerce.matriz_stock_group_movements m WHERE m.environment=env
        AND m.reference=ref::text AND m.group_id=c.group_id AND m.from_location=c.location_code
        AND m.movement_type='consume' AND m.detail->>'source'=channel),0) END
      WHERE c.environment=env AND c.origin_id=p.id AND c.group_id IS NOT NULL;
    SELECT p.quantity-coalesce(sum(c.suggested_quantity),0) INTO loose FROM commerce.matriz_stock_origin_candidates c
      WHERE c.origin_id=p.id AND c.environment=env;
    IF loose>0 THEN
      UPDATE commerce.matriz_stock_origin_candidates SET suggested_quantity=loose WHERE origin_id=p.id AND group_id IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'stock_origin_allocation_mismatch'; END IF;
    ELSIF loose<0 THEN RAISE EXCEPTION 'stock_origin_allocation_mismatch'; END IF;
    UPDATE commerce.matriz_stock_origins SET snapshot_ready=true WHERE id=p.id;
    fresh_ids:=array_append(fresh_ids,p.id);
  END LOOP;
  -- SKUs da mesma medida/marca podem dividir o saldo sem grupo. Depois do rateio
  -- todos os SKUs já consumiram suas partes. Descarta opções que só pareciam
  -- possíveis antes de abater a cesta completa. Em reserva o saldo oficial é
  -- atualizado pelo chamador imediatamente depois deste snapshot.
  FOR p IN SELECT * FROM commerce.matriz_stock_origins WHERE id=ANY(fresh_ids) LOOP
    IF NOT EXISTS(WITH options AS (
        SELECT c.group_id,c.matched_set,least(c.capacity,greatest(0,z.capacity-
          CASE WHEN mode='reservation' AND c.group_id IS NULL THEN p.variant_quantity ELSE 0 END)) cap
        FROM commerce.matriz_stock_origin_candidates c
        JOIN commerce.matriz_stock_origin_supply(env,sid) z ON z.group_id IS NOT DISTINCT FROM c.group_id
          AND z.location_code IS NOT DISTINCT FROM c.location_code
        WHERE c.environment=env AND c.origin_id=p.id
      ), totals AS (SELECT group_id,bool_or(matched_set) matched,sum(cap) qty FROM options GROUP BY group_id)
      SELECT 1 FROM totals WHERE matched AND qty>=2 AND qty<(SELECT sum(qty) FROM totals)
        AND p.quantity<(SELECT sum(qty) FROM totals)
    ) THEN
      DELETE FROM commerce.matriz_stock_origin_candidates WHERE environment=env AND origin_id=p.id;
      DELETE FROM commerce.matriz_stock_origins WHERE environment=env AND id=p.id;
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION commerce.finish_matriz_stock_origin_reservation(env env_t,ref uuid,consume boolean)
RETURNS void LANGUAGE sql SET search_path=pg_catalog,commerce AS $$
  UPDATE commerce.matriz_stock_origins SET phase=CASE WHEN consume THEN 'consumed' ELSE phase END,
    status=CASE WHEN consume THEN status ELSE 'cancelled' END
  WHERE environment=env AND source='varejo' AND reference_id=ref AND phase='reserved' AND status<>'cancelled'
$$;

-- Os dois triggers envolvem o rateio legado: o primeiro fotografa as opções e
-- o segundo lê as posições que efetivamente foram debitadas, sob o mesmo lock.
CREATE FUNCTION commerce.track_matriz_stock_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,commerce AS $$
DECLARE channel text:=current_setting('app.galpao_source',true);
  reference text:=current_setting('app.galpao_ref',true); ref uuid;
BEGIN
  IF reference IS NULL OR reference !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
  ref:=reference::uuid;
  IF NEW.quantity_on_hand<OLD.quantity_on_hand AND NEW.quantity_reserved=OLD.quantity_reserved
    AND channel IN ('varejo','venda_atacado') AND OLD.vehicle_type IS DISTINCT FROM 'motorcycle' THEN
    IF TG_WHEN='BEFORE' THEN
      PERFORM commerce.capture_matriz_stock_origin(OLD.environment,OLD.id,ref,channel,OLD.quantity_on_hand-NEW.quantity_on_hand,NULL);
    ELSE PERFORM commerce.snapshot_matriz_stock_origin(OLD.environment,OLD.id,ref,channel); END IF;
  ELSIF TG_WHEN='AFTER' AND NEW.quantity_on_hand>OLD.quantity_on_hand AND channel IN ('cancelamento_varejo','cancelamento_venda') THEN
    UPDATE commerce.matriz_stock_origins SET status='cancelled' WHERE environment=OLD.environment
      AND reference_id=ref AND stock_id=OLD.id AND status<>'cancelled'
      AND source=CASE WHEN channel='cancelamento_varejo' THEN 'varejo' ELSE 'venda_atacado' END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_stock_origin_before_groups BEFORE UPDATE OF quantity_on_hand ON commerce.wholesale_stock
  FOR EACH ROW EXECUTE FUNCTION commerce.track_matriz_stock_origin();
CREATE TRIGGER capture_stock_origin_after_groups AFTER UPDATE OF quantity_on_hand ON commerce.wholesale_stock
  FOR EACH ROW EXECUTE FUNCTION commerce.track_matriz_stock_origin();
CREATE FUNCTION commerce.protect_open_stock_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,commerce AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM commerce.matriz_stock_origins p WHERE p.environment=OLD.environment
    AND p.stock_id=OLD.id AND p.status='pending') THEN RAISE EXCEPTION 'stock_origin_changed'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER protect_open_stock_origin BEFORE DELETE ON commerce.wholesale_stock
  FOR EACH ROW EXECUTE FUNCTION commerce.protect_open_stock_origin();

-- Ajusta exclusivamente a decomposição física da venda. A baixa e a reserva
-- agregadas já foram registradas antes de o separador identificar a origem.
CREATE FUNCTION commerce.shift_matriz_origin_candidate(env env_t,cid uuid,delta int,actor text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,commerce AS $$
DECLARE row record; previous int; mov record; n int; left_to_reverse int;
BEGIN
  SELECT c.*,p.reference_id,p.phase,p.source,g.product_id actual_product INTO STRICT row
  FROM commerce.matriz_stock_origin_candidates c JOIN commerce.matriz_stock_origins p
    ON p.environment=c.environment AND p.id=c.origin_id
  LEFT JOIN commerce.matriz_stock_groups g ON g.environment=c.environment AND g.id=c.group_id
  WHERE c.environment=env AND c.id=cid AND p.status='pending' AND p.snapshot_ready;
  IF delta=0 THEN RETURN; END IF;
  UPDATE commerce.matriz_stock_origin_candidates SET suggested_quantity=suggested_quantity+delta
    WHERE id=cid AND suggested_quantity+delta BETWEEN 0 AND capacity;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock_origin_changed'; END IF;
  IF row.group_id IS NULL THEN RETURN; END IF;

  UPDATE commerce.matriz_stock_group_positions SET
    quantity_reserved=quantity_reserved+CASE WHEN row.phase='reserved' THEN delta ELSE 0 END,
    quantity_on_hand=quantity_on_hand-CASE WHEN row.phase='consumed' THEN delta ELSE 0 END
    WHERE environment=env AND group_id=row.group_id AND location_code=row.location_code
      AND (delta<0 OR quantity_on_hand-quantity_reserved>=delta)
      AND (row.phase<>'reserved' OR quantity_reserved+delta>=0);
  IF NOT FOUND THEN RAISE EXCEPTION 'stock_origin_changed'; END IF;
  IF row.source='varejo' THEN
    SELECT CASE WHEN a.status=row.phase THEN a.quantity ELSE 0 END INTO previous
    FROM commerce.matriz_stock_group_allocations a WHERE a.environment=env AND a.order_id=row.reference_id
      AND a.group_id=row.group_id AND a.location_code=row.location_code AND NOT a.specific_offer;
    IF coalesce(previous,0)+delta<0 THEN RAISE EXCEPTION 'stock_origin_changed'; END IF;
    IF coalesce(previous,0)+delta=0 THEN
      UPDATE commerce.matriz_stock_group_allocations SET status='released',finalized_at=clock_timestamp()
        WHERE environment=env AND order_id=row.reference_id AND group_id=row.group_id AND location_code=row.location_code;
    ELSE
      INSERT INTO commerce.matriz_stock_group_allocations(environment,order_id,group_id,product_id,location_code,model,
        quantity,status,finalized_at) VALUES(env,row.reference_id,row.group_id,row.actual_product,row.location_code,
        row.model,coalesce(previous,0)+delta,row.phase,CASE WHEN row.phase='reserved' THEN NULL ELSE clock_timestamp() END)
      ON CONFLICT(environment,order_id,group_id,location_code) DO UPDATE SET quantity=EXCLUDED.quantity,
        status=EXCLUDED.status,finalized_at=EXCLUDED.finalized_at WHERE NOT matriz_stock_group_allocations.specific_offer;
      IF NOT FOUND THEN RAISE EXCEPTION 'stock_origin_changed'; END IF;
    END IF;
  END IF;

  IF row.phase='consumed' AND delta<0 THEN
    left_to_reverse:=-delta;
    FOR mov IN SELECT m.id,m.quantity-coalesce((SELECT sum(r.quantity) FROM commerce.matriz_stock_group_movements r
        WHERE r.reverses_movement_id=m.id),0) restorable
      FROM commerce.matriz_stock_group_movements m WHERE m.environment=env AND m.reference=row.reference_id::text
        AND m.group_id=row.group_id AND m.from_location=row.location_code AND m.movement_type='consume'
        AND m.detail->>'source'=row.source ORDER BY m.created_at,m.id
    LOOP
      n:=least(mov.restorable,left_to_reverse);
      IF n<=0 THEN CONTINUE; END IF;
      INSERT INTO commerce.matriz_stock_group_movements(environment,group_id,order_id,reference,movement_type,
        to_location,quantity,reverses_movement_id,actor_label,detail)
      VALUES(env,row.group_id,CASE WHEN row.source='varejo' THEN row.reference_id END,row.reference_id::text,'return',
        row.location_code,n,mov.id,actor,jsonb_build_object('source','stock_origin_confirmation','origin_id',row.origin_id));
      left_to_reverse:=left_to_reverse-n;
      EXIT WHEN left_to_reverse=0;
    END LOOP;
    IF left_to_reverse<>0 THEN RAISE EXCEPTION 'stock_origin_changed'; END IF;
  ELSE
    INSERT INTO commerce.matriz_stock_group_movements(environment,group_id,order_id,reference,movement_type,
      from_location,quantity,actor_label,detail) VALUES(env,row.group_id,CASE WHEN row.source='varejo' THEN row.reference_id END,
      row.reference_id::text,CASE WHEN row.phase='consumed' THEN 'consume' WHEN delta>0 THEN 'reserve' ELSE 'release' END,
      row.location_code,abs(delta),actor,jsonb_build_object('source',row.source,'origin_id',row.origin_id));
  END IF;
  UPDATE commerce.matriz_stock_groups SET revision=revision+1,updated_at=clock_timestamp()
    WHERE environment=env AND id=row.group_id;
END $$;

ALTER TABLE commerce.matriz_stock_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.matriz_stock_origin_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.matriz_stock_origins,commerce.matriz_stock_origin_candidates FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.matriz_stock_active_set(env_t,uuid),commerce.matriz_stock_origin_candidate_pending(env_t,uuid),
  commerce.matriz_stock_origin_uncertain(env_t,uuid),commerce.matriz_stock_origin_supply(env_t,uuid,boolean),
  commerce.capture_matriz_stock_origin(env_t,uuid,uuid,text,int,jsonb),commerce.snapshot_matriz_stock_origin(env_t,uuid,uuid,text),
  commerce.finish_matriz_stock_origin_reservation(env_t,uuid,boolean),commerce.track_matriz_stock_origin(),commerce.protect_open_stock_origin(),
  commerce.shift_matriz_origin_candidate(env_t,uuid,int,text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','partner_app','farejador_partner_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON commerce.matriz_stock_origins,commerce.matriz_stock_origin_candidates FROM %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
