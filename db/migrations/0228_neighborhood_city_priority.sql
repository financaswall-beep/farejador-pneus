-- Preferência operacional de município para nomes compartilhados.
-- A carga regional define os valores; a migration não cadastra cidades/bairros.
-- Município explícito continua sendo filtro obrigatório e nunca é substituído.
ALTER TABLE commerce.geo_resolutions
  ADD COLUMN IF NOT EXISTS city_resolution_priority SMALLINT NOT NULL DEFAULT 0
    CHECK (city_resolution_priority >= 0);

COMMENT ON COLUMN commerce.geo_resolutions.city_resolution_priority IS
  'Preferência operacional em empates de bairro sem município informado. Não altera pertencimento territorial nem cobertura de entrega. Zero = sem preferência.';

CREATE OR REPLACE FUNCTION commerce.resolve_neighborhood(
  p_environment env_t,
  p_input TEXT,
  p_city TEXT DEFAULT NULL,
  p_min_similarity NUMERIC DEFAULT 0.4
) RETURNS TABLE (
  geo_resolution_id UUID,
  neighborhood_canonical TEXT,
  city_name TEXT,
  match_type TEXT,
  match_similarity NUMERIC
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  norm_input TEXT := lower(unaccent(trim(p_input)));
  norm_city TEXT := CASE WHEN p_city IS NULL THEN NULL ELSE lower(unaccent(trim(p_city))) END;
BEGIN
  RETURN QUERY
  SELECT g.id, g.neighborhood_canonical, g.city_name, 'exact'::TEXT, 1.0::NUMERIC
  FROM commerce.geo_resolutions g
  WHERE g.environment = p_environment
    AND lower(unaccent(g.neighborhood_canonical)) = norm_input
    AND (norm_city IS NULL OR lower(unaccent(g.city_name)) = norm_city)
  ORDER BY CASE WHEN norm_city IS NULL THEN g.city_resolution_priority ELSE 0 END DESC,
           g.created_at, g.id;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT g.id, g.neighborhood_canonical, g.city_name, 'alias'::TEXT, 0.95::NUMERIC
  FROM commerce.geo_resolutions g
  WHERE g.environment = p_environment
    AND norm_input = ANY(SELECT lower(unaccent(unnest(g.aliases))))
    AND (norm_city IS NULL OR lower(unaccent(g.city_name)) = norm_city)
  ORDER BY CASE WHEN norm_city IS NULL THEN g.city_resolution_priority ELSE 0 END DESC,
           g.created_at, g.id;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT g.id, g.neighborhood_canonical, g.city_name, 'fuzzy'::TEXT,
         similarity(unaccent(g.neighborhood_canonical), unaccent(p_input))::NUMERIC
  FROM commerce.geo_resolutions g
  WHERE g.environment = p_environment
    AND similarity(unaccent(g.neighborhood_canonical), unaccent(p_input)) > p_min_similarity
    AND (norm_city IS NULL OR lower(unaccent(g.city_name)) = norm_city)
  ORDER BY similarity(unaccent(g.neighborhood_canonical), unaccent(p_input)) DESC,
           CASE WHEN norm_city IS NULL THEN g.city_resolution_priority ELSE 0 END DESC,
           g.created_at, g.id
  LIMIT 5;
END;
$$;

COMMENT ON FUNCTION commerce.resolve_neighborhood IS
  'Resolve bairro por exact, alias e fuzzy, ignorando acentos. Preferência regional desempata somente sem município informado; mantém todos os candidatos. Não resolve automaticamente outras ambiguidades.';
