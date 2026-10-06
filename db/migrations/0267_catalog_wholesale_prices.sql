-- Preço publicado para compra do parceiro. Não participa do preço do bot/varejo.
-- Nenhum preço é copiado automaticamente: vazio significa oferta não publicada.
CREATE TABLE commerce.wholesale_product_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  product_id UUID NOT NULL REFERENCES commerce.products(id),
  price_amount NUMERIC(10,2) NOT NULL CHECK (price_amount > 0),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency='BRL'),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);
COMMENT ON TABLE commerce.wholesale_product_prices IS
  'Preço de atacado publicado pela Matriz para parceiros. Isolado de custo, matriz_product_prices, product_prices e das consultas do bot.';

CREATE UNIQUE INDEX wholesale_product_prices_one_open_idx
  ON commerce.wholesale_product_prices(environment,product_id) WHERE valid_until IS NULL;
CREATE INDEX wholesale_product_prices_history_idx
  ON commerce.wholesale_product_prices(environment,product_id,valid_from DESC);

CREATE TRIGGER env_match_wholesale_price_product
  BEFORE INSERT OR UPDATE OF product_id ON commerce.wholesale_product_prices
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce','products','product_id');
CREATE TRIGGER env_immutable_wholesale_product_prices
  BEFORE UPDATE OF environment ON commerce.wholesale_product_prices
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

CREATE FUNCTION commerce.guard_wholesale_price_window() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
  -- Serializa também gravações SQL diretas, além da API do Catálogo.
  PERFORM 1 FROM commerce.products
    WHERE environment=NEW.environment AND id=NEW.product_id
      AND product_type='tire' AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog_wholesale_product_invalid' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM commerce.wholesale_product_prices wp
     WHERE wp.environment=NEW.environment AND wp.product_id=NEW.product_id AND wp.id<>NEW.id
       AND tstzrange(wp.valid_from,wp.valid_until,'[)')
           && tstzrange(NEW.valid_from,NEW.valid_until,'[)')
  ) THEN
    RAISE EXCEPTION 'catalog_wholesale_price_window_overlap' USING ERRCODE='23P01';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION commerce.guard_wholesale_price_window() FROM PUBLIC;
CREATE TRIGGER wholesale_product_price_window_guard
  BEFORE INSERT OR UPDATE OF environment,product_id,valid_from,valid_until
  ON commerce.wholesale_product_prices
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_wholesale_price_window();
CREATE TRIGGER wholesale_product_price_immutable_update
  BEFORE UPDATE ON commerce.wholesale_product_prices
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_price_history();
CREATE TRIGGER wholesale_product_price_immutable_delete
  BEFORE DELETE ON commerce.wholesale_product_prices
  FOR EACH ROW EXECUTE FUNCTION commerce.guard_catalog_price_history();

CREATE VIEW commerce.wholesale_current_prices AS
SELECT environment,product_id,price_amount,currency,valid_from,valid_until
  FROM commerce.wholesale_product_prices
 WHERE valid_from<=now() AND (valid_until IS NULL OR valid_until>now());
COMMENT ON VIEW commerce.wholesale_current_prices IS
  'Somente oferta de atacado. Não substituir as views de preço da Matriz ou da Rede.';
REVOKE ALL ON commerce.wholesale_product_prices,commerce.wholesale_current_prices
  FROM PUBLIC,farejador_partner_app;

DO $check$
BEGIN
  IF has_table_privilege('farejador_partner_app','commerce.wholesale_product_prices','SELECT')
     OR has_table_privilege('farejador_partner_app','commerce.wholesale_current_prices','SELECT') THEN
    RAISE EXCEPTION '0267 falhou: acesso direto de parceiro ao preço de atacado';
  END IF;
  IF pg_get_viewdef('commerce.current_prices'::regclass) ILIKE '%wholesale%'
     OR pg_get_viewdef('commerce.matriz_current_prices'::regclass) ILIKE '%wholesale%'
     OR pg_get_viewdef('commerce.product_full'::regclass) ILIKE '%wholesale_product_prices%'
     OR pg_get_viewdef('commerce.product_full'::regclass) ILIKE '%wholesale_current_prices%' THEN
    RAISE EXCEPTION '0267 falhou: preço de atacado presente na fonte de preço do bot';
  END IF;
END;
$check$;
