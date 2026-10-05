-- O cadastro simples vincula o estoque local a uma variante do catálogo central.
-- A role do parceiro precisa ler as medidas e executar os dois normalizadores.
-- Sem esses grants, a consulta falha antes do INSERT do pneu na própria loja.
-- São acessos de leitura; a escrita no catálogo central continua vedada.

GRANT SELECT ON commerce.tire_specs TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION commerce.catalog_measure_identity(TEXT)
  TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION commerce.catalog_brand_identity(TEXT)
  TO farejador_partner_app;
