-- 0047_resolve_vehicle_model_prefers_useful.sql
-- Reescreve commerce.resolve_vehicle_model pra preferir candidatos uteis
-- (com fitment cadastrado, com variant, com ano definido) em vez de retornar
-- o primeiro match literal.
--
-- Bug que motivou esta migration (conv 592 turn 2/3, 2026-05-22):
--   resolve_vehicle_model('PCX', 2025) retornava a entrada generica
--   "Honda PCX" (year_start=NULL, year_end=NULL, 0 fitments) em vez de
--   "Honda PCX 160 (2023-2026)" que tem 2 fitments cadastrados, porque
--   o nivel exact_full batia primeiro com o nome literal "pcx" e o
--   IF FOUND matava o caminho do alias/fuzzy.
--
-- Afeta TODAS as motos que tem familia (PCX, Biz, Pop, NXR Bros, XRE,
-- CRF, Africa Twin, Lander, Ténéré, V-Strom, Burgman, Vulcan, etc.):
--   42 modelos genericos do catalogo (sem ano, sem variant, sem fitment)
--   estavam roubando a frente das variantes uteis.
--
-- Regra nova de ordenacao no resultado final:
--   1. tem fitment cadastrado                    (TRUE primeiro)
--   2. anos da variante cobrem p_year passado    (TRUE primeiro)
--   3. tem variant nao-nulo                      (TRUE primeiro)
--   4. tem ano definido (year_start nao-nulo)    (TRUE primeiro)
--   5. tipo de match (exact_full > exact_model > alias > fuzzy)
--   6. similarity descendente
--   7. mais recente primeiro (year_end DESC)
--   8. determinismo (model ASC, variant ASC NULLS LAST)
--
-- Cada modelo aparece UMA vez no resultado, mesmo se bater em varios
-- niveis de match (DISTINCT ON pegando o melhor rank).
--
-- Nota: todas as colunas internas dos CTEs sao prefixadas com vm_* pra
-- evitar ambiguidade com os nomes do RETURNS TABLE.

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
  WITH all_candidates AS (
    -- Nivel 1: exact_full (make+model+variant ou model+variant)
    SELECT v.id AS vm_id, v.make AS vm_make, v.model AS vm_model, v.variant AS vm_variant,
           v.year_start AS vm_year_start, v.year_end AS vm_year_end, v.displacement_cc AS vm_cc,
           'exact_full'::TEXT AS vm_match_type,
           1.0::NUMERIC AS vm_similarity,
           1 AS vm_rank
    FROM commerce.vehicle_models v
    WHERE v.environment = p_environment
      AND v.deleted_at IS NULL
      AND (
        lower(trim(v.make || ' ' || v.model || COALESCE(' ' || v.variant, ''))) = normalized_input
        OR lower(trim(v.model || COALESCE(' ' || v.variant, ''))) = normalized_input
      )
      AND (p_year IS NULL OR v.year_start IS NULL OR v.year_start <= p_year)
      AND (p_year IS NULL OR v.year_end IS NULL OR v.year_end >= p_year)

    UNION ALL

    -- Nivel 2: exact_model (lower(model) = input)
    SELECT v.id, v.make, v.model, v.variant,
           v.year_start, v.year_end, v.displacement_cc,
           'exact_model'::TEXT, 0.90::NUMERIC, 2
    FROM commerce.vehicle_models v
    WHERE v.environment = p_environment
      AND v.deleted_at IS NULL
      AND lower(v.model) = normalized_input
      AND (p_year IS NULL OR v.year_start IS NULL OR v.year_start <= p_year)
      AND (p_year IS NULL OR v.year_end IS NULL OR v.year_end >= p_year)

    UNION ALL

    -- Nivel 3: alias (input bate com um dos aliases)
    SELECT v.id, v.make, v.model, v.variant,
           v.year_start, v.year_end, v.displacement_cc,
           'alias'::TEXT, 0.95::NUMERIC, 3
    FROM commerce.vehicle_models v
    WHERE v.environment = p_environment
      AND v.deleted_at IS NULL
      AND normalized_input = ANY(SELECT lower(unnest(v.aliases)))
      AND (p_year IS NULL OR v.year_start IS NULL OR v.year_start <= p_year)
      AND (p_year IS NULL OR v.year_end IS NULL OR v.year_end >= p_year)

    UNION ALL

    -- Nivel 4: fuzzy (similarity pg_trgm)
    SELECT v.id, v.make, v.model, v.variant,
           v.year_start, v.year_end, v.displacement_cc,
           'fuzzy'::TEXT,
           GREATEST(
             similarity(v.model, p_input),
             similarity(v.model || COALESCE(' ' || v.variant, ''), p_input),
             similarity(v.make || ' ' || v.model || COALESCE(' ' || v.variant, ''), p_input)
           )::NUMERIC AS vm_similarity,
           4 AS vm_rank
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
  ),
  -- Cada modelo aparece uma vez, ficando com seu MELHOR match (menor rank)
  deduped AS (
    SELECT DISTINCT ON (vm_id)
      vm_id, vm_make, vm_model, vm_variant,
      vm_year_start, vm_year_end, vm_cc,
      vm_match_type, vm_similarity, vm_rank
    FROM all_candidates
    ORDER BY vm_id, vm_rank ASC, vm_similarity DESC
  ),
  -- Anota fitments_count e year_match_strength pra cada candidato
  scored AS (
    SELECT d.*,
           (SELECT COUNT(*) FROM commerce.vehicle_fitments f
            WHERE f.vehicle_model_id = d.vm_id
              AND f.environment = p_environment) AS vm_fitments_count,
           CASE
             WHEN p_year IS NOT NULL
                  AND d.vm_year_start IS NOT NULL
                  AND d.vm_year_end IS NOT NULL
                  AND p_year BETWEEN d.vm_year_start AND d.vm_year_end THEN 1
             ELSE 0
           END AS vm_year_match
    FROM deduped d
  )
  SELECT
    s.vm_id, s.vm_make, s.vm_model, s.vm_variant,
    s.vm_year_start, s.vm_year_end, s.vm_cc,
    s.vm_match_type, s.vm_similarity
  FROM scored s
  ORDER BY
    -- 1. Util de verdade (tem fitment cadastrado)
    (s.vm_fitments_count > 0) DESC,
    -- 2. Anos cobrem o ano passado pelo cliente
    s.vm_year_match DESC,
    -- 3. Variant nao-nula (mais especifico)
    (s.vm_variant IS NOT NULL) DESC,
    -- 4. Ano definido (year_start nao-nulo)
    (s.vm_year_start IS NOT NULL) DESC,
    -- 5. Tipo de match (menor rank = match mais forte)
    s.vm_rank ASC,
    -- 6. Similaridade descendente
    s.vm_similarity DESC,
    -- 7. Mais recente primeiro
    s.vm_year_end DESC NULLS LAST,
    -- 8. Determinismo
    s.vm_model ASC, s.vm_variant ASC NULLS LAST
  LIMIT 5;
END;
$$;

COMMENT ON FUNCTION commerce.resolve_vehicle_model IS
  'Resolve modelo de veiculo. Acumula candidatos de 4 niveis de match (exact_full, exact_model, alias, fuzzy), deduplica por id (melhor rank), e ordena por utilidade: prefere variantes com fitment cadastrado, com anos que cobrem p_year, com variant, com ano definido — antes do tipo de match. Evita que entradas genericas (sem ano/variant/fitment) roubem a frente das variantes uteis.';
