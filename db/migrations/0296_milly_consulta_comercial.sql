BEGIN;

CREATE TABLE ops.milly_consulta_config (
  environment env_t PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_person_id uuid NOT NULL REFERENCES network.partner_people(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops.milly_consultas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  generation uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES core.conversations(id) ON DELETE CASCADE,
  trigger_message_id uuid NOT NULL,
  unit_id uuid NOT NULL REFERENCES core.units(id),
  product_id uuid NOT NULL REFERENCES commerce.products(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('pix','cartao','dinheiro')),
  fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('pickup','delivery')),
  offered_total_cents integer NOT NULL CHECK (offered_total_cents > 0),
  catalog_unit_cents integer NOT NULL CHECK (catalog_unit_cents > 0),
  freight_cents integer NOT NULL CHECK (freight_cents >= 0),
  destination_key text CHECK (destination_key ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','declined','cancelled','sending','published','consumed')),
  decision text CHECK (decision IN ('manter','aguardar_dado','aceitar','contrapropor')),
  orientation text CHECK (orientation IS NULL OR (decision IN ('manter','aguardar_dado')
    AND orientation IN ('oferecer_retirada','pedir_proposta','seguir_tabela'))),
  approved_total_cents integer CHECK (approved_total_cents > freight_cents),
  decided_by uuid REFERENCES network.partner_people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_deadline timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '50 seconds'),
  valid_until timestamptz,
  body_sha256 text CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  published_at timestamptz,
  published_provider_id bigint,
  order_id uuid UNIQUE REFERENCES commerce.orders(id),
  UNIQUE (environment,id),
  UNIQUE (environment,conversation_id,trigger_message_id),
  CHECK ((fulfillment_mode='pickup' AND freight_cents=0 AND destination_key IS NULL)
      OR (fulfillment_mode='delivery' AND destination_key IS NOT NULL)),
  CHECK (approved_total_cents IS NULL OR (approved_total_cents - freight_cents) % quantity = 0),
  CHECK (state NOT IN ('approved','sending','published','consumed')
    OR (approved_total_cents IS NOT NULL AND valid_until IS NOT NULL AND decision IN ('aceitar','contrapropor'))),
  CHECK ((state IN ('published','consumed')) = (published_at IS NOT NULL)),
  CHECK ((state='consumed') = (order_id IS NOT NULL))
);
CREATE INDEX milly_consulta_por_oferta ON ops.milly_consultas(environment,conversation_id,created_at DESC)
  WHERE state IN ('sending','published');

ALTER TABLE ops.outbound_messages ADD COLUMN milly_offer_id uuid,
  ADD FOREIGN KEY (environment,milly_offer_id) REFERENCES ops.milly_consultas(environment,id)
    ON DELETE SET NULL (milly_offer_id);

-- O preço já gravado em commerce.orders permanece no histórico comercial da loja.
CREATE FUNCTION ops.erase_milly_consultas() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  DELETE FROM ops.milly_consultas r USING core.conversations c,core.contacts ct
    WHERE r.environment=NEW.environment AND c.environment=r.environment AND c.id=r.conversation_id
      AND ct.id=c.contact_id AND ct.environment=c.environment AND ct.id=NEW.contact_id AND ct.deleted_at IS NOT NULL;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION ops.erase_milly_consultas() FROM PUBLIC;
CREATE TRIGGER milly_consultas_erasure AFTER INSERT ON ops.erasure_log
  FOR EACH ROW WHEN (NEW.contact_id IS NOT NULL) EXECUTE FUNCTION ops.erase_milly_consultas();

ALTER TABLE ops.milly_consulta_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.milly_consultas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.milly_consulta_config,ops.milly_consultas FROM PUBLIC;
DO $$ DECLARE nome text; BEGIN
  FOREACH nome IN ARRAY ARRAY['anon','authenticated','service_role','farejador_partner_app'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=nome) THEN
      EXECUTE format('REVOKE ALL ON ops.milly_consulta_config,ops.milly_consultas FROM %I',nome);
    END IF;
  END LOOP;
END $$;
COMMIT;
