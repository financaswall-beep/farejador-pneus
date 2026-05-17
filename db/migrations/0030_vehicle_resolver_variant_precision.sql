-- 0030_vehicle_resolver_variant_precision.sql
-- Faz o resolvedor preferir modelo + versao antes do match generico por modelo.
-- Ex.: "CG 160 Cargo" nao deve cair em linhas genericas/Fan/Titan de "CG 160".

CREATE OR REPLACE FUNCTION commerce.resolve_vehicle_model(
  p_environment    env_t,
  p_input          TEXT,
  p_year           INTEGER DEFAULT NULL,
  p_min_similarity NUMERIC DEFAULT 0.5
) RETURNS TABLE (
  vehicle_model_id UUID,
  make TEXT,
  model TEXT,
  variant TEXT,
  year_start INTEGER,
  year_end INTEGER,
  displacement_cc INTEGER,
  match_type TEXT,
  match_similarity NUMERIC
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  normalized_input TEXT := lower(trim(p_input));
BEGIN
  RETURN QUERY
  SELECT v.id, v.make, v.model, v.variant, v.year_start, v.year_end,
         v.displacement_cc, 'exact_full'::TEXT, 1.0::NUMERIC
  FROM commerce.vehicle_models v
  WHERE v.environment = p_environment
    AND v.deleted_at IS NULL
    AND (
      lower(trim(v.make || ' ' || v.model || COALESCE(' ' || v.variant, ''))) = normalized_input
      OR lower(trim(v.model || COALESCE(' ' || v.variant, ''))) = normalized_input
    )
    AND (p_year IS NULL OR v.year_start IS NULL OR v.year_start <= p_year)
    AND (p_year IS NULL OR v.year_end IS NULL OR v.year_end >= p_year)
  ORDER BY v.year_start DESC NULLS LAST, v.year_end ASC NULLS LAST, v.model ASC, v.variant ASC NULLS LAST
  LIMIT 5;

  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT v.id, v.make, v.model, v.variant, v.year_start, v.year_end,
         v.displacement_cc, 'exact_model'::TEXT, 0.90::NUMERIC
  FROM commerce.vehicle_models v
  WHERE v.environment = p_environment
    AND v.deleted_at IS NULL
    AND lower(v.model) = normalized_input
    AND (p_year IS NULL OR v.year_start IS NULL OR v.year_start <= p_year)
    AND (p_year IS NULL OR v.year_end IS NULL OR v.year_end >= p_year)
  ORDER BY
    CASE WHEN v.variant IS NULL THEN 0 ELSE 1 END,
    v.year_start DESC NULLS LAST,
    v.model ASC,
    v.variant ASC NULLS LAST
  LIMIT 5;

  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT v.id, v.make, v.model, v.variant, v.year_start, v.year_end,
         v.displacement_cc, 'alias'::TEXT, 0.95::NUMERIC
  FROM commerce.vehicle_models v
  WHERE v.environment = p_environment
    AND v.deleted_at IS NULL
    AND normalized_input = ANY(SELECT lower(unnest(v.aliases)))
    AND (p_year IS NULL OR v.year_start IS NULL OR v.year_start <= p_year)
    AND (p_year IS NULL OR v.year_end IS NULL OR v.year_end >= p_year)
  ORDER BY v.year_start DESC NULLS LAST, v.year_end ASC NULLS LAST, v.model ASC, v.variant ASC NULLS LAST
  LIMIT 5;

  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT v.id, v.make, v.model, v.variant, v.year_start, v.year_end,
         v.displacement_cc, 'fuzzy'::TEXT,
         GREATEST(
           similarity(v.model, p_input),
           similarity(v.model || COALESCE(' ' || v.variant, ''), p_input),
           similarity(v.make || ' ' || v.model || COALESCE(' ' || v.variant, ''), p_input)
         )::NUMERIC AS match_similarity
  FROM commerce.vehicle_models v
  WHERE v.environment = p_environment
    AND v.deleted_at IS NULL
    AND (
      similarity(v.model, p_input) > p_min_similarity
      OR similarity(v.model || COALESCE(' ' || v.variant, ''), p_input) > p_min_similarity
      OR similarity(v.make || ' ' || v.model || COALESCE(' ' || v.variant, ''), p_input) > p_min_similarity
    )
    AND (p_year IS NULL OR v.year_start IS NULL OR v.year_start <= p_year)
    AND (p_year IS NULL OR v.year_end IS NULL OR v.year_end >= p_year)
  ORDER BY match_similarity DESC, v.year_start DESC NULLS LAST, v.model ASC, v.variant ASC NULLS LAST
  LIMIT 5;
END;
$$;

COMMENT ON FUNCTION commerce.resolve_vehicle_model IS 'Resolve modelo de veiculo por match exato de modelo+versao, modelo, alias ou pg_trgm; usado pelo Planner/Atendente antes de compatibilidade.';
