-- 0048_resolve_neighborhood_ignora_acentos.sql
-- Bug observado em conv 595 (2026-05-23): cliente digitou "Niteroi" sem til,
-- banco tem "Niterói" com til. resolve_neighborhood comparava com lower() puro,
-- e `lower('Niterói')='niterói' != 'niteroi'=lower('Niteroi')` → match falhava.
--
-- Resultado prático: o bot foi honesto ("bairro não localizado") mas dava
-- impressão de gap no catálogo. Na verdade Fonseca estava cadastrada — só
-- não bateu por causa do acento na cidade.
--
-- Fix:
-- 1. Habilita extensão unaccent (remove acentos: 'á'→'a', 'ç'→'c', 'õ'→'o', etc.)
-- 2. Reescreve commerce.resolve_neighborhood usando lower(unaccent(...))
--    nas 3 comparações (neighborhood_canonical, aliases, city_name).
-- 3. Trim continua aplicado pra remover espaços extras.
--
-- Resultado esperado:
--   resolve_neighborhood('Fonseca', 'Niteroi')  → match exato (cobre cliente sem til)
--   resolve_neighborhood('Fonseca', 'Niterói')  → match exato (cobre com til)
--   resolve_neighborhood('Sao Goncalo')         → bate "São Gonçalo"
--   resolve_neighborhood('saú lourenço')        → bate "Sao Lourenco" (typos com acento)

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION commerce.resolve_neighborhood(
  p_environment    env_t,
  p_input          TEXT,
  p_city           TEXT DEFAULT NULL,
  p_min_similarity NUMERIC DEFAULT 0.4
) RETURNS TABLE (
  geo_resolution_id UUID,
  neighborhood_canonical TEXT,
  city_name TEXT,
  match_type TEXT,
  match_similarity NUMERIC
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  norm_input TEXT := lower(unaccent(trim(p_input)));
  norm_city  TEXT := CASE WHEN p_city IS NULL THEN NULL ELSE lower(unaccent(trim(p_city))) END;
BEGIN
  -- Nivel 1: match exato (case + acento insensitive) no neighborhood_canonical
  RETURN QUERY
  SELECT g.id, g.neighborhood_canonical, g.city_name, 'exact'::TEXT, 1.0::NUMERIC
  FROM commerce.geo_resolutions g
  WHERE g.environment = p_environment
    AND lower(unaccent(g.neighborhood_canonical)) = norm_input
    AND (norm_city IS NULL OR lower(unaccent(g.city_name)) = norm_city);

  IF FOUND THEN RETURN; END IF;

  -- Nivel 2: match em alias (case + acento insensitive)
  RETURN QUERY
  SELECT g.id, g.neighborhood_canonical, g.city_name, 'alias'::TEXT, 0.95::NUMERIC
  FROM commerce.geo_resolutions g
  WHERE g.environment = p_environment
    AND norm_input = ANY(SELECT lower(unaccent(unnest(g.aliases))))
    AND (norm_city IS NULL OR lower(unaccent(g.city_name)) = norm_city);

  IF FOUND THEN RETURN; END IF;

  -- Nivel 3: fuzzy (pg_trgm) — similarity ignora acentos ja na funcao similarity?
  -- Por seguranca, aplicamos unaccent antes da comparacao.
  RETURN QUERY
  SELECT g.id, g.neighborhood_canonical, g.city_name, 'fuzzy'::TEXT,
         similarity(unaccent(g.neighborhood_canonical), unaccent(p_input))::NUMERIC AS match_similarity
  FROM commerce.geo_resolutions g
  WHERE g.environment = p_environment
    AND similarity(unaccent(g.neighborhood_canonical), unaccent(p_input)) > p_min_similarity
    AND (norm_city IS NULL OR lower(unaccent(g.city_name)) = norm_city)
  ORDER BY similarity(unaccent(g.neighborhood_canonical), unaccent(p_input)) DESC
  LIMIT 5;
END;
$$;

COMMENT ON FUNCTION commerce.resolve_neighborhood IS
  'Resolve bairro com normalizacao de acentos (lower+unaccent). Cobre input sem til ("Niteroi") batendo com canonico ("Niterói"). Tambem normaliza aliases e fuzzy match. 3 niveis: exact -> alias -> fuzzy (trigram pg_trgm).';
