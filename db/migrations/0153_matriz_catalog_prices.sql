-- 0153 - Preco oficial do Catalogo da Matriz, isolado da tabela comercial da Rede.
--
-- Regra de negocio (2026-07-29):
--   * o bot consulta este preco somente quando a venda pertence a Matriz;
--   * parceiros continuam usando o fluxo de preco que ja existia;
--   * alteracoes preservam historico temporal e nunca reescrevem vendas fechadas.

CREATE TABLE IF NOT EXISTS commerce.matriz_product_prices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   env_t NOT NULL,
  product_id    UUID NOT NULL REFERENCES commerce.products(id),
  price_amount  NUMERIC(10, 2) NOT NULL CHECK (price_amount >= 0),
  currency      TEXT NOT NULL DEFAULT 'BRL',
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

COMMENT ON TABLE commerce.matriz_product_prices IS
  'Preco temporal exclusivo da Matriz. Fonte oficial do Catalogo, venda avulsa e bot quando o pedido fica na Matriz; nao altera preco da Rede.';

CREATE INDEX IF NOT EXISTS matriz_product_prices_active_idx
  ON commerce.matriz_product_prices(environment,product_id,valid_from DESC,valid_until DESC NULLS FIRST);

DROP TRIGGER IF EXISTS env_match_matriz_prices_product ON commerce.matriz_product_prices;
CREATE TRIGGER env_match_matriz_prices_product
  BEFORE INSERT OR UPDATE OF product_id ON commerce.matriz_product_prices
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'products', 'product_id');

DROP TRIGGER IF EXISTS env_immutable_matriz_product_prices ON commerce.matriz_product_prices;
CREATE TRIGGER env_immutable_matriz_product_prices
  BEFORE UPDATE OF environment ON commerce.matriz_product_prices
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

CREATE OR REPLACE VIEW commerce.matriz_current_prices AS
SELECT DISTINCT ON (environment,product_id)
  environment,product_id,price_amount,currency,'matriz'::text AS price_type,valid_from,valid_until
FROM commerce.matriz_product_prices
WHERE valid_from<=now() AND (valid_until IS NULL OR valid_until>now())
ORDER BY environment,product_id,valid_from DESC,id DESC;

COMMENT ON VIEW commerce.matriz_current_prices IS
  'Preco oficial vigente exclusivo da Matriz. Nao deve ser usado para pedido ou venda direta de parceiro.';

-- Na virada, a Matriz nasce com o mesmo preco vigente que ja oferecia. A copia
-- separa as fontes dali em diante sem apagar nem alterar a tabela usada pela Rede.
INSERT INTO commerce.matriz_product_prices
  (environment,product_id,price_amount,currency,valid_from)
SELECT cp.environment,cp.product_id,cp.price_amount,cp.currency,now()
  FROM commerce.current_prices cp
 WHERE NOT EXISTS (
   SELECT 1 FROM commerce.matriz_product_prices mp
    WHERE mp.environment=cp.environment AND mp.product_id=cp.product_id
      AND mp.valid_from<=now() AND (mp.valid_until IS NULL OR mp.valid_until>now())
 );

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema='commerce' AND table_name='matriz_product_prices'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.views
     WHERE table_schema='commerce' AND table_name='matriz_current_prices'
  ) THEN
    RAISE EXCEPTION '0153 falhou: fonte de preco exclusiva da Matriz ausente';
  END IF;

  IF has_table_privilege('farejador_partner_app','commerce.matriz_product_prices','SELECT') THEN
    RAISE EXCEPTION '0153 falhou: parceiro nao pode ler a tabela de precos da Matriz';
  END IF;
END;
$check$;
