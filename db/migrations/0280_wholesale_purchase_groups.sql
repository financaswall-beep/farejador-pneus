BEGIN;

-- A viagem é somente uma etiqueta. Nenhuma coluna de dinheiro ou estoque.
CREATE TABLE commerce.wholesale_purchase_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  group_number bigint GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by text,
  UNIQUE(environment,id), UNIQUE(environment,group_number),
  CHECK ((status='open' AND closed_at IS NULL) OR (status='closed' AND closed_at IS NOT NULL))
);
CREATE TABLE commerce.wholesale_purchase_group_purchases (
  environment env_t NOT NULL,
  group_id uuid NOT NULL,
  purchase_id uuid NOT NULL,
  linked_by text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,purchase_id),
  FOREIGN KEY(environment,group_id) REFERENCES commerce.wholesale_purchase_groups(environment,id),
  FOREIGN KEY(environment,purchase_id) REFERENCES commerce.wholesale_purchases(environment,id)
);
CREATE TABLE commerce.wholesale_purchase_group_expenses (
  environment env_t NOT NULL,
  group_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  linked_by text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,expense_id),
  FOREIGN KEY(environment,group_id) REFERENCES commerce.wholesale_purchase_groups(environment,id),
  FOREIGN KEY(environment,expense_id) REFERENCES commerce.matriz_expenses(environment,id)
);
CREATE INDEX purchase_group_purchases_group_idx ON commerce.wholesale_purchase_group_purchases(environment,group_id);
CREATE INDEX purchase_group_expenses_group_idx ON commerce.wholesale_purchase_group_expenses(environment,group_id);

CREATE FUNCTION commerce.purchase_group_expense_owned(p_env env_t,p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,commerce,finance AS $$
 SELECT EXISTS(SELECT 1 FROM commerce.matriz_delivery_trips WHERE environment=p_env AND fuel_expense_id=p_id)
 OR EXISTS(SELECT 1 FROM commerce.matriz_trip_receipts WHERE environment=p_env AND ai_expense_id=p_id)
 OR EXISTS(SELECT 1 FROM commerce.matriz_trip_lost_receipts WHERE environment=p_env AND expense_id=p_id)
 OR EXISTS(SELECT 1 FROM finance.matriz_payroll_items WHERE environment=p_env AND source_expense_id=p_id)
 OR EXISTS(SELECT 1 FROM finance.matriz_commission_periods WHERE environment=p_env AND source_expense_id=p_id)
$$;

CREATE FUNCTION commerce.guard_purchase_group_links()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,commerce AS $$
DECLARE v_env public.env_t; v_group uuid; v_status text; v_order uuid; v_current uuid;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'purchase_group_link_immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN v_env:=OLD.environment; v_group:=OLD.group_id;
 ELSE v_env:=NEW.environment; v_group:=NEW.group_id; END IF;
 SELECT status INTO v_status FROM commerce.wholesale_purchase_groups
 WHERE environment=v_env AND id=v_group FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'purchase_group_not_found' USING ERRCODE='23503'; END IF;
 IF v_status<>'open' THEN RAISE EXCEPTION 'purchase_group_closed' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_TABLE_NAME='wholesale_purchase_group_purchases' THEN
   SELECT status,purchase_order_id INTO v_status,v_order FROM commerce.wholesale_purchases
   WHERE environment=v_env AND id=NEW.purchase_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'purchase_not_found' USING ERRCODE='23503'; END IF;
   IF v_status='cancelled' THEN RAISE EXCEPTION 'purchase_cancelled' USING ERRCODE='23514'; END IF;
   SELECT group_id INTO v_current FROM commerce.wholesale_purchase_group_purchases
   WHERE environment=v_env AND purchase_id=NEW.purchase_id;
   IF v_current IS NOT NULL THEN RAISE EXCEPTION 'purchase_already_grouped' USING ERRCODE='23505'; END IF;
   IF v_order IS NOT NULL THEN
     PERFORM pg_advisory_xact_lock(hashtextextended('purchase-group-order:'||v_env||':'||v_order,0));
     IF EXISTS(SELECT 1 FROM commerce.wholesale_purchase_group_purchases l
       JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
       WHERE l.environment=v_env AND p.purchase_order_id=v_order AND l.group_id<>v_group) THEN
       RAISE EXCEPTION 'purchase_order_split_across_groups' USING ERRCODE='23514';
     END IF;
   END IF;
 ELSE
   PERFORM pg_advisory_xact_lock(hashtextextended('purchase-group-expense:'||v_env||':'||NEW.expense_id,0));
   IF NOT EXISTS(SELECT 1 FROM commerce.matriz_expenses WHERE environment=v_env AND id=NEW.expense_id AND deleted_at IS NULL) THEN
     RAISE EXCEPTION 'expense_not_found' USING ERRCODE='23503';
   END IF;
   IF commerce.purchase_group_expense_owned(v_env,NEW.expense_id) THEN
     RAISE EXCEPTION 'expense_owned_by_other_module' USING ERRCODE='23514';
   END IF;
   IF EXISTS(SELECT 1 FROM commerce.wholesale_purchase_group_expenses WHERE environment=v_env AND expense_id=NEW.expense_id) THEN
     RAISE EXCEPTION 'expense_already_grouped' USING ERRCODE='23505';
   END IF;
 END IF;
 RETURN NEW;
END $$;

-- O caminho inverso também respeita a exclusividade: módulo dono não pode
-- apropriar-se depois de uma despesa que já foi vinculada a uma viagem.
CREATE FUNCTION commerce.guard_purchase_group_expense_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,commerce AS $$
DECLARE v_id uuid;
BEGIN
 v_id:=(to_jsonb(NEW)->>TG_ARGV[0])::uuid;
 IF v_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(OLD)->>TG_ARGV[0]) IS NOT DISTINCT FROM v_id::text THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('purchase-group-expense:'||NEW.environment||':'||v_id,0));
 IF EXISTS(SELECT 1 FROM commerce.wholesale_purchase_group_expenses WHERE environment=NEW.environment AND expense_id=v_id) THEN
   RAISE EXCEPTION 'expense_owned_by_other_module' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION commerce.guard_purchase_group_order_change()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,commerce AS $$
DECLARE v_group uuid;
BEGIN
 IF NEW.purchase_order_id IS NULL OR NEW.purchase_order_id IS NOT DISTINCT FROM OLD.purchase_order_id THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('purchase-group-order:'||NEW.environment||':'||NEW.purchase_order_id,0));
 SELECT group_id INTO v_group FROM commerce.wholesale_purchase_group_purchases
 WHERE environment=NEW.environment AND purchase_id=NEW.id;
 IF v_group IS NOT NULL AND EXISTS(SELECT 1 FROM commerce.wholesale_purchase_group_purchases l
   JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
   WHERE l.environment=NEW.environment AND p.purchase_order_id=NEW.purchase_order_id AND l.group_id<>v_group) THEN
   RAISE EXCEPTION 'purchase_order_split_across_groups' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_group_order_change BEFORE UPDATE OF purchase_order_id ON commerce.wholesale_purchases
 FOR EACH ROW EXECUTE FUNCTION commerce.guard_purchase_group_order_change();

DO $guards$ DECLARE t text; schema_name text; column_name text; BEGIN
 FOREACH t IN ARRAY ARRAY['wholesale_purchase_groups','wholesale_purchase_group_purchases','wholesale_purchase_group_expenses'] LOOP
   EXECUTE format('CREATE TRIGGER purchase_group_environment_immutable BEFORE UPDATE OF environment ON commerce.%I FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['wholesale_purchase_group_purchases','wholesale_purchase_group_expenses'] LOOP
   EXECUTE format('CREATE TRIGGER purchase_group_link_guard BEFORE INSERT OR UPDATE OR DELETE ON commerce.%I FOR EACH ROW EXECUTE FUNCTION commerce.guard_purchase_group_links()',t);
 END LOOP;
 FOR schema_name,t,column_name IN SELECT * FROM (VALUES
   ('commerce','matriz_delivery_trips','fuel_expense_id'),('commerce','matriz_trip_receipts','ai_expense_id'),
   ('commerce','matriz_trip_lost_receipts','expense_id'),('finance','matriz_payroll_items','source_expense_id'),
   ('finance','matriz_commission_periods','source_expense_id')) x(s,t,c) LOOP
   EXECUTE format('CREATE TRIGGER purchase_group_expense_owner_guard BEFORE INSERT OR UPDATE OF %I ON %I.%I FOR EACH ROW EXECUTE FUNCTION commerce.guard_purchase_group_expense_owner(%L)',column_name,schema_name,t,column_name);
 END LOOP;
END $guards$;

ALTER TABLE commerce.wholesale_purchase_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.wholesale_purchase_group_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.wholesale_purchase_group_expenses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.wholesale_purchase_groups,commerce.wholesale_purchase_group_purchases,commerce.wholesale_purchase_group_expenses FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.purchase_group_expense_owned(env_t,uuid),commerce.guard_purchase_group_links(),commerce.guard_purchase_group_expense_owner(),commerce.guard_purchase_group_order_change() FROM PUBLIC;
DO $access$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','partner_app','farejador_partner_app'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON commerce.wholesale_purchase_groups,commerce.wholesale_purchase_group_purchases,commerce.wholesale_purchase_group_expenses FROM %I',r);
   EXECUTE format('REVOKE ALL ON FUNCTION commerce.purchase_group_expense_owned(env_t,uuid),commerce.guard_purchase_group_links(),commerce.guard_purchase_group_expense_owner(),commerce.guard_purchase_group_order_change() FROM %I',r);
  END IF;
 END LOOP;
END $access$;
DO $smoke$ DECLARE r text; t text; privilege text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','partner_app','farejador_partner_app'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   FOREACH t IN ARRAY ARRAY['wholesale_purchase_groups','wholesale_purchase_group_purchases','wholesale_purchase_group_expenses'] LOOP
    FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
     IF has_table_privilege(r,'commerce.'||t,privilege) THEN RAISE EXCEPTION 'purchase_group_privilege_leak: % % %',r,t,privilege; END IF;
    END LOOP;
   END LOOP;
  END IF;
 END LOOP;
END $smoke$;
COMMIT;
