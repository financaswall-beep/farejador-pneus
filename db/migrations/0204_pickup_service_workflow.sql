BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('farejador:migration:0204_pickup_service_workflow', 0));

-- O pedido continua sendo a unica verdade. Enquanto o atendimento nao termina,
-- os servicos ficam como rascunho no proprio pedido e nao afetam venda, caixa,
-- estoque, custo ou comissao.
ALTER TABLE commerce.orders
  ADD COLUMN IF NOT EXISTS pickup_arrived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pickup_installation_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pickup_services JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE commerce.partner_orders
  ADD COLUMN IF NOT EXISTS pickup_arrived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pickup_installation_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pickup_services JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_pickup_services_array') THEN
    ALTER TABLE commerce.orders ADD CONSTRAINT orders_pickup_services_array
      CHECK (jsonb_typeof(pickup_services)='array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='partner_orders_pickup_services_array') THEN
    ALTER TABLE commerce.partner_orders ADD CONSTRAINT partner_orders_pickup_services_array
      CHECK (jsonb_typeof(pickup_services)='array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_pickup_stage_order') THEN
    ALTER TABLE commerce.orders ADD CONSTRAINT orders_pickup_stage_order CHECK (
      pickup_installation_started_at IS NULL OR (
        pickup_arrived_at IS NOT NULL
        AND pickup_installation_started_at>=pickup_arrived_at
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='partner_orders_pickup_stage_order') THEN
    ALTER TABLE commerce.partner_orders ADD CONSTRAINT partner_orders_pickup_stage_order CHECK (
      pickup_installation_started_at IS NULL OR (
        pickup_arrived_at IS NOT NULL
        AND pickup_installation_started_at>=pickup_arrived_at
      )
    );
  END IF;
END
$constraints$;

COMMENT ON COLUMN commerce.orders.pickup_services IS
  'Rascunho validado de servicos do atendimento. So vira order_items na confirmacao final.';
COMMENT ON COLUMN commerce.partner_orders.pickup_services IS
  'Rascunho validado de servicos do atendimento. So vira partner_order_items na confirmacao final.';

-- A chave por item torna a materializacao idempotente: um retry nunca duplica
-- montagem, valor, comissao ou resultado.
ALTER TABLE commerce.order_items
  ADD COLUMN IF NOT EXISTS pickup_service_code TEXT;
ALTER TABLE commerce.partner_order_items
  ADD COLUMN IF NOT EXISTS pickup_service_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS order_items_pickup_service_uniq
  ON commerce.order_items(environment,order_id,pickup_service_code)
  WHERE pickup_service_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS partner_order_items_pickup_service_uniq
  ON commerce.partner_order_items(environment,order_id,pickup_service_code)
  WHERE pickup_service_code IS NOT NULL;

-- A Matriz exige product_id em todo item. Estes produtos internos permitem que
-- servicos usem o mesmo motor de pedido/comissao sem inventar uma tabela financeira.
INSERT INTO commerce.products (
  environment,product_code,product_name,product_type,internal_notes
)
SELECT environment,code,name,'service',
       'Servico interno de retirada. Preco definido no atendimento; sem estoque.'
  FROM (VALUES ('prod'::env_t),('test'::env_t)) envs(environment)
 CROSS JOIN (VALUES
   ('PICKUP-SERVICE-MOUNTING','Montagem do pneu'),
   ('PICKUP-SERVICE-VALVE','Troca de bico'),
   ('PICKUP-SERVICE-BALANCING','Balanceamento')
 ) services(code,name)
ON CONFLICT (environment,product_code) DO UPDATE
      SET product_name=EXCLUDED.product_name,
          product_type='service',
          deleted_at=NULL,
          updated_at=now();

CREATE INDEX IF NOT EXISTS orders_pickup_queue_idx
  ON commerce.orders(environment,pickup_arrived_at,pickup_installation_started_at,created_at DESC)
  WHERE fulfillment_mode='pickup' AND status='open';
CREATE INDEX IF NOT EXISTS partner_orders_pickup_queue_idx
  ON commerce.partner_orders(environment,unit_id,pickup_arrived_at,pickup_installation_started_at,created_at DESC)
  WHERE fulfillment_mode='pickup' AND awaiting_pickup AND deleted_at IS NULL;

DO $smoke$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='commerce' AND table_name='orders'
       AND column_name='pickup_services' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='commerce' AND table_name='partner_orders'
       AND column_name='pickup_services' AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'smoke 0204: estado do atendimento ausente';
  END IF;
  IF (SELECT count(*) FROM commerce.products
       WHERE product_code LIKE 'PICKUP-SERVICE-%' AND deleted_at IS NULL) <> 6 THEN
    RAISE EXCEPTION 'smoke 0204: catalogo interno de servicos incompleto';
  END IF;
END
$smoke$;

COMMIT;
