-- Pedido do app: envio sem movimento; reserva na aprovação; documentos no despacho.
CREATE TABLE commerce.partner_wholesale_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment public.env_t NOT NULL,
  partner_unit_id uuid NOT NULL REFERENCES network.partner_units(id),
  request_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  submitted_items jsonb NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','dispatched')),
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents BETWEEN 0 AND 99999999999),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz, approved_by text,
  rejected_at timestamptz, rejected_by text, rejection_reason text,
  dispatched_at timestamptz, dispatched_by text,
  wholesale_order_id uuid UNIQUE REFERENCES commerce.wholesale_orders(id),
  receipt_key text, receipt_items jsonb, receipt_result jsonb,
  UNIQUE(environment,partner_unit_id,idempotency_key), UNIQUE(environment,id)
);
CREATE TABLE commerce.partner_wholesale_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment public.env_t NOT NULL,
  request_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES commerce.products(id),
  measure text NOT NULL, brand text NOT NULL, catalog_measure text NOT NULL, catalog_brand text, tire_condition text NOT NULL,
  vehicle_type text NOT NULL CHECK (vehicle_type IN ('motorcycle','car')),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents BETWEEN 1 AND 99999999999),
  wholesale_order_item_id uuid UNIQUE REFERENCES commerce.wholesale_order_items(id),
  FOREIGN KEY(environment,request_id) REFERENCES commerce.partner_wholesale_requests(environment,id),
  UNIQUE(request_id,product_id), UNIQUE(request_id,measure,brand,tire_condition)
);
CREATE INDEX partner_wholesale_requests_queue ON commerce.partner_wholesale_requests(environment,status,created_at);
CREATE INDEX partner_wholesale_requests_unit ON commerce.partner_wholesale_requests(partner_unit_id,environment,created_at DESC);

CREATE FUNCTION commerce.check_partner_wholesale_request_environment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='partner_wholesale_requests' THEN
    IF NOT EXISTS (SELECT 1 FROM network.partner_units u WHERE u.id=NEW.partner_unit_id AND u.environment=NEW.environment)
      OR (NEW.wholesale_order_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM commerce.wholesale_orders o WHERE o.id=NEW.wholesale_order_id AND o.environment=NEW.environment
          AND o.partner_unit_id=NEW.partner_unit_id)) THEN RAISE EXCEPTION 'request_environment_mismatch'; END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM commerce.products p WHERE p.id=NEW.product_id AND p.environment=NEW.environment)
      OR (NEW.wholesale_order_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM commerce.wholesale_order_items i JOIN commerce.partner_wholesale_requests r
          ON r.id=NEW.request_id AND r.environment=NEW.environment
        WHERE i.id=NEW.wholesale_order_item_id AND i.environment=NEW.environment AND i.order_id=r.wholesale_order_id))
      THEN RAISE EXCEPTION 'request_environment_mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_wholesale_requests_environment BEFORE INSERT OR UPDATE
  ON commerce.partner_wholesale_requests FOR EACH ROW EXECUTE FUNCTION commerce.check_partner_wholesale_request_environment();
CREATE TRIGGER partner_wholesale_request_items_environment BEFORE INSERT OR UPDATE
  ON commerce.partner_wholesale_request_items FOR EACH ROW EXECUTE FUNCTION commerce.check_partner_wholesale_request_environment();

ALTER TABLE commerce.partner_wholesale_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_wholesale_request_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_wholesale_requests_read ON commerce.partner_wholesale_requests FOR SELECT TO farejador_partner_app
  USING (EXISTS (SELECT 1 FROM network.partner_units u JOIN network.partners p ON p.id=u.partner_id AND p.environment=u.environment
    WHERE u.id=network.current_partner_unit() AND u.status='active' AND p.status='active'
      AND u.id=partner_wholesale_requests.partner_unit_id AND u.environment=partner_wholesale_requests.environment));
CREATE POLICY partner_wholesale_request_items_read ON commerce.partner_wholesale_request_items FOR SELECT TO farejador_partner_app
  USING (EXISTS (SELECT 1 FROM commerce.partner_wholesale_requests r
    WHERE r.id=partner_wholesale_request_items.request_id AND r.environment=partner_wholesale_request_items.environment));
REVOKE ALL ON commerce.partner_wholesale_requests,commerce.partner_wholesale_request_items FROM PUBLIC,farejador_partner_app;
GRANT SELECT ON commerce.partner_wholesale_requests,commerce.partner_wholesale_request_items TO farejador_partner_app;

CREATE FUNCTION commerce.submit_partner_wholesale_request(request_key text,request_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  unit_id uuid; request_env public.env_t; normalized jsonb; row_data commerce.partner_wholesale_requests%ROWTYPE;
  element jsonb; item_count integer; inserted_count integer; quoted_total bigint;
BEGIN
  SELECT u.id,u.environment INTO unit_id,request_env FROM network.partner_units u
    JOIN network.partners p ON p.id=u.partner_id AND p.environment=u.environment
    WHERE u.id=network.current_partner_unit() AND u.status='active' AND p.status='active';
  IF unit_id IS NULL THEN RAISE EXCEPTION 'partner_inactive'; END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 8 AND 200
    OR jsonb_typeof(request_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid_request'; END IF;
  item_count := jsonb_array_length(request_items);
  IF item_count NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'invalid_request'; END IF;
  FOR element IN SELECT value FROM jsonb_array_elements(request_items) LOOP
    IF jsonb_typeof(element) IS DISTINCT FROM 'object'
      OR COALESCE(element->>'offer_key','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR COALESCE(element->>'quantity','') !~ '^[0-9]{1,3}$'
      OR COALESCE(element->>'expected_price_cents','') !~ '^[0-9]{1,11}$'
      THEN RAISE EXCEPTION 'invalid_request'; END IF;
    IF (element->>'quantity')::int NOT BETWEEN 1 AND 999
      OR (element->>'expected_price_cents')::bigint NOT BETWEEN 1 AND 99999999999
      THEN RAISE EXCEPTION 'invalid_request'; END IF;
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object('offer_key',(e->>'offer_key')::uuid,
    'quantity',(e->>'quantity')::int,'expected_price_cents',(e->>'expected_price_cents')::bigint)
    ORDER BY (e->>'offer_key')::uuid) INTO normalized FROM jsonb_array_elements(request_items) e;
  IF (SELECT count(DISTINCT e->>'offer_key') FROM jsonb_array_elements(normalized) e) <> item_count
    THEN RAISE EXCEPTION 'duplicate_offer'; END IF;
  INSERT INTO commerce.partner_wholesale_requests(environment,partner_unit_id,idempotency_key,submitted_items)
    VALUES(request_env,unit_id,request_key,normalized) ON CONFLICT(environment,partner_unit_id,idempotency_key) DO NOTHING;
  SELECT * INTO row_data FROM commerce.partner_wholesale_requests r
    WHERE r.environment=request_env AND r.partner_unit_id=unit_id AND r.idempotency_key=request_key FOR UPDATE;
  IF row_data.submitted_items <> normalized THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
  IF EXISTS (SELECT 1 FROM commerce.partner_wholesale_request_items WHERE request_id=row_data.id) THEN
    RETURN jsonb_build_object('request_id',row_data.id,'request_number','CMP-'||row_data.request_number,
      'status',row_data.status,'total_cents',row_data.total_cents,'idempotent',true);
  END IF;
  INSERT INTO commerce.partner_wholesale_request_items(environment,request_id,product_id,measure,brand,catalog_measure,catalog_brand,
    tire_condition,vehicle_type,quantity,unit_price_cents)
    SELECT request_env,row_data.id,c.offer_key,s.measure,s.brand,c.measure,c.brand,c.tire_condition,c.vehicle_type,
      (e->>'quantity')::int,c.price_cents
    FROM jsonb_array_elements(normalized) e JOIN commerce.partner_wholesale_catalog() c ON c.offer_key=(e->>'offer_key')::uuid
    JOIN commerce.wholesale_stock s ON s.environment=request_env AND s.tire_condition=c.tire_condition
      AND commerce.catalog_measure_identity(s.measure)=commerce.catalog_measure_identity(c.measure)
      AND commerce.catalog_brand_identity(s.brand)=commerce.catalog_brand_identity(c.brand)
    WHERE c.price_cents=(e->>'expected_price_cents')::bigint AND c.price_cents>0
      AND c.quantity_available>=(e->>'quantity')::int;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count<>item_count THEN RAISE EXCEPTION 'offer_changed'; END IF;
  SELECT sum(quantity*unit_price_cents) INTO quoted_total FROM commerce.partner_wholesale_request_items WHERE request_id=row_data.id;
  IF quoted_total>99999999999 THEN RAISE EXCEPTION 'invalid_request'; END IF;
  UPDATE commerce.partner_wholesale_requests SET total_cents=quoted_total WHERE id=row_data.id RETURNING * INTO row_data;
  INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
    VALUES(request_env,'partner_wholesale_request','commerce.partner_wholesale_requests',row_data.id,'submitted',
      'partner-unit:'||unit_id,jsonb_build_object('total_cents',row_data.total_cents,'items',normalized));
  RETURN jsonb_build_object('request_id',row_data.id,'request_number','CMP-'||row_data.request_number,
    'status',row_data.status,'total_cents',row_data.total_cents,'idempotent',false);
END $$;
REVOKE ALL ON FUNCTION commerce.submit_partner_wholesale_request(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.submit_partner_wholesale_request(text,jsonb) TO farejador_partner_app;

-- Somente projeção dos documentos próprios, sem conceder acesso às tabelas da matriz.
CREATE FUNCTION commerce.partner_wholesale_requests_for_unit() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('id',r.id,'request_number','CMP-'||r.request_number,'status',r.status,
   'total_cents',r.total_cents,'created_at',r.created_at,'rejection_reason',r.rejection_reason,
   'payment_status',o.payment_status,'receipt_status',p.receipt_status,'due_date',o.due_date,
   'settled_total_cents',(o.settled_total_amount*100)::bigint,
   'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('item_id',i.id,'measure',i.catalog_measure,'brand',i.catalog_brand,
     'tire_condition',i.tire_condition,'vehicle_type',i.vehicle_type,'quantity',i.quantity,'unit_price_cents',i.unit_price_cents,
     'received_quantity',pi.received_quantity) ORDER BY i.measure,i.brand)
     FROM commerce.partner_wholesale_request_items i
     LEFT JOIN commerce.partner_purchase_items pi ON pi.source_wholesale_order_item_id=i.wholesale_order_item_id
       AND pi.environment=i.environment
     WHERE i.request_id=r.id AND i.environment=r.environment),'[]'::jsonb))
 FROM commerce.partner_wholesale_requests r
 JOIN network.partner_units u ON u.id=r.partner_unit_id AND u.environment=r.environment
 JOIN network.partners partner ON partner.id=u.partner_id AND partner.environment=u.environment
 LEFT JOIN commerce.wholesale_orders o ON o.id=r.wholesale_order_id AND o.environment=r.environment
 LEFT JOIN commerce.partner_purchases p ON p.source_wholesale_order_id=o.id AND p.environment=o.environment AND p.deleted_at IS NULL
 WHERE u.id=network.current_partner_unit() AND u.status='active' AND partner.status='active'
 ORDER BY (r.status IN ('requested','approved') OR (r.status='dispatched' AND p.receipt_status='pending')) DESC,r.created_at DESC,r.id LIMIT 50;
$$;
REVOKE ALL ON FUNCTION commerce.partner_wholesale_requests_for_unit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.partner_wholesale_requests_for_unit() TO farejador_partner_app;
