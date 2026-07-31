-- 0157_partner_condition_routing_guard.sql
-- Estoque de parceiro sem condicao continua visivel para revisao humana, mas
-- nunca pode participar de busca, roteamento ou venda do bot.

INSERT INTO audit.events (
  environment, domain, entity_table, entity_id, event_type, actor_label, payload_after
)
SELECT
  psl.environment,
  'stock',
  'commerce.partner_stock_levels',
  psl.id,
  'partner_stock_pending_condition_unlinked',
  'migration:0157',
  jsonb_build_object(
    'product_id', psl.product_id,
    'reason', 'pending_tire_condition_cannot_route'
  )
FROM commerce.partner_stock_levels psl
WHERE COALESCE(psl.item_type, 'pneu') = 'pneu'
  AND psl.tire_condition IS NULL
  AND psl.product_id IS NOT NULL;

UPDATE commerce.partner_stock_levels
   SET product_id = NULL,
       updated_by = 'migration:0157',
       updated_at = now()
 WHERE COALESCE(item_type, 'pneu') = 'pneu'
   AND tire_condition IS NULL
   AND product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION commerce.validate_partner_stock_tire_condition()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE v_product_condition TEXT;
BEGIN
  IF COALESCE(NEW.item_type, 'pneu') = 'pneu'
     AND NEW.tire_condition IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'tire_condition_required';
    END IF;
    IF NEW.product_id IS NOT NULL THEN
      RAISE EXCEPTION 'partner_stock_condition_review_required';
    END IF;
  END IF;

  IF NEW.product_id IS NOT NULL
     AND COALESCE(NEW.item_type, 'pneu') = 'pneu' THEN
    SELECT tire_condition
      INTO v_product_condition
      FROM commerce.products
     WHERE id = NEW.product_id
       AND environment = NEW.environment;
    IF v_product_condition IS DISTINCT FROM NEW.tire_condition THEN
      RAISE EXCEPTION 'partner_stock_product_condition_conflict';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE INDEX IF NOT EXISTS partner_stock_routable_product_idx
  ON commerce.partner_stock_levels(environment, unit_id, product_id)
  WHERE deleted_at IS NULL
    AND product_id IS NOT NULL
    AND tire_condition IS NOT NULL;

COMMENT ON INDEX commerce.partner_stock_routable_product_idx IS
  'Acelera somente estoque classificado que pode participar do roteamento do bot.';

DO $check$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM commerce.partner_stock_levels
     WHERE COALESCE(item_type, 'pneu') = 'pneu'
       AND tire_condition IS NULL
       AND product_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0157 falhou: estoque pendente continuou vinculado ao catalogo';
  END IF;
END;
$check$;
