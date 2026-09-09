-- Vigência opcional da aplicação de cada medida de pneu em um modelo.
-- Os anos do modelo continuam descrevendo a fabricação da moto; estes campos
-- dizem em quais anos a associação pneu x moto é válida.

BEGIN;

ALTER TABLE commerce.vehicle_fitments
  ADD COLUMN IF NOT EXISTS year_start INTEGER,
  ADD COLUMN IF NOT EXISTS year_end INTEGER;

ALTER TABLE commerce.fitment_discoveries
  ADD COLUMN IF NOT EXISTS suggested_year_start INTEGER,
  ADD COLUMN IF NOT EXISTS suggested_year_end INTEGER;

UPDATE commerce.vehicle_fitments vf
   SET year_start=CASE
         WHEN vm.year_start BETWEEN 1900 AND 2100
          AND (vm.year_end IS NULL OR (vm.year_end BETWEEN 1900 AND 2100
            AND vm.year_end >= vm.year_start)) THEN vm.year_start
         ELSE NULL
       END,
       year_end=CASE
         WHEN vm.year_end BETWEEN 1900 AND 2100
          AND (vm.year_start IS NULL OR (vm.year_start BETWEEN 1900 AND 2100
            AND vm.year_end >= vm.year_start)) THEN vm.year_end
         ELSE NULL
       END
  FROM commerce.vehicle_models vm
 WHERE vm.id=vf.vehicle_model_id
   AND vm.environment=vf.environment
   AND vf.year_start IS NULL
   AND vf.year_end IS NULL;

UPDATE commerce.fitment_discoveries d
   SET suggested_year_start=CASE
         WHEN vm.year_start BETWEEN 1900 AND 2100
          AND (vm.year_end IS NULL OR (vm.year_end BETWEEN 1900 AND 2100
            AND vm.year_end >= vm.year_start)) THEN vm.year_start
         ELSE NULL
       END,
       suggested_year_end=CASE
         WHEN vm.year_end BETWEEN 1900 AND 2100
          AND (vm.year_start IS NULL OR (vm.year_start BETWEEN 1900 AND 2100
            AND vm.year_end >= vm.year_start)) THEN vm.year_end
         ELSE NULL
       END
  FROM commerce.vehicle_models vm
 WHERE vm.id=d.vehicle_model_id
   AND vm.environment=d.environment
   AND d.suggested_year_start IS NULL
   AND d.suggested_year_end IS NULL;

ALTER TABLE commerce.vehicle_fitments
  DROP CONSTRAINT IF EXISTS vehicle_fitments_year_start_check,
  DROP CONSTRAINT IF EXISTS vehicle_fitments_year_end_check,
  DROP CONSTRAINT IF EXISTS vehicle_fitments_year_range_check,
  ADD CONSTRAINT vehicle_fitments_year_start_check
    CHECK (year_start IS NULL OR year_start BETWEEN 1900 AND 2100),
  ADD CONSTRAINT vehicle_fitments_year_end_check
    CHECK (year_end IS NULL OR year_end BETWEEN 1900 AND 2100),
  ADD CONSTRAINT vehicle_fitments_year_range_check
    CHECK (year_start IS NULL OR year_end IS NULL OR year_end >= year_start);

ALTER TABLE commerce.fitment_discoveries
  DROP CONSTRAINT IF EXISTS fitment_discoveries_year_start_check,
  DROP CONSTRAINT IF EXISTS fitment_discoveries_year_end_check,
  DROP CONSTRAINT IF EXISTS fitment_discoveries_year_range_check,
  ADD CONSTRAINT fitment_discoveries_year_start_check
    CHECK (suggested_year_start IS NULL OR suggested_year_start BETWEEN 1900 AND 2100),
  ADD CONSTRAINT fitment_discoveries_year_end_check
    CHECK (suggested_year_end IS NULL OR suggested_year_end BETWEEN 1900 AND 2100),
  ADD CONSTRAINT fitment_discoveries_year_range_check
    CHECK (suggested_year_start IS NULL OR suggested_year_end IS NULL
      OR suggested_year_end >= suggested_year_start);

CREATE INDEX IF NOT EXISTS vehicle_fitments_vehicle_year_idx
  ON commerce.vehicle_fitments (environment,vehicle_model_id,year_start,year_end);

COMMENT ON COLUMN commerce.vehicle_fitments.year_start IS
  'Primeiro ano em que esta medida/posição é aplicável ao modelo. NULL significa sem limite inicial conhecido.';
COMMENT ON COLUMN commerce.vehicle_fitments.year_end IS
  'Último ano em que esta medida/posição é aplicável ao modelo. NULL significa sem limite final conhecido.';
COMMENT ON COLUMN commerce.fitment_discoveries.suggested_year_start IS
  'Início opcional da vigência sugerida pela evidência antes da aprovação.';
COMMENT ON COLUMN commerce.fitment_discoveries.suggested_year_end IS
  'Fim opcional da vigência sugerida pela evidência antes da aprovação.';

CREATE OR REPLACE FUNCTION commerce.find_compatible_tires(
  p_environment      env_t,
  p_vehicle_model_id UUID,
  p_position         TEXT,
  p_year             INTEGER
) RETURNS TABLE (
  product_id        UUID,
  product_name      TEXT,
  brand             TEXT,
  tire_size         TEXT,
  fitment_year_start INTEGER,
  fitment_year_end   INTEGER,
  fitment_position  TEXT,
  is_oem            BOOLEAN,
  fitment_source    TEXT,
  confidence_level  NUMERIC,
  current_price     NUMERIC,
  total_stock       INTEGER
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    p.id,
    p.product_name,
    p.brand,
    ts.tire_size,
    f.year_start,
    f.year_end,
    f.position AS fitment_position,
    f.is_oem,
    f.source AS fitment_source,
    f.confidence_level,
    cp.price_amount,
    COALESCE(SUM(sl.quantity_available), 0)::INTEGER
  FROM commerce.vehicle_fitments f
  JOIN commerce.tire_specs ts
    ON ts.id=f.tire_spec_id AND ts.environment=f.environment
  JOIN commerce.products p
    ON p.id=ts.product_id AND p.environment=ts.environment AND p.deleted_at IS NULL
  LEFT JOIN commerce.current_prices cp
    ON cp.product_id=p.id AND cp.environment=p.environment
  LEFT JOIN commerce.stock_levels sl
    ON sl.product_id=p.id AND sl.environment=p.environment
  WHERE f.environment=p_environment
    AND f.vehicle_model_id=p_vehicle_model_id
    AND (p_position IS NULL OR f.position=p_position OR f.position='both')
    AND (p_year IS NULL OR (
      (f.year_start IS NULL OR f.year_start <= p_year)
      AND (f.year_end IS NULL OR f.year_end >= p_year)
    ))
  GROUP BY p.id,p.product_name,p.brand,ts.tire_size,
           f.year_start,f.year_end,f.position,f.is_oem,f.source,
           f.confidence_level,cp.price_amount
  ORDER BY f.is_oem DESC,f.confidence_level DESC NULLS LAST,p.product_name;
$$;

CREATE OR REPLACE FUNCTION commerce.find_compatible_tires(
  p_environment      env_t,
  p_vehicle_model_id UUID,
  p_position         TEXT DEFAULT NULL
) RETURNS TABLE (
  product_id        UUID,
  product_name      TEXT,
  brand             TEXT,
  tire_size         TEXT,
  fitment_position  TEXT,
  is_oem            BOOLEAN,
  fitment_source    TEXT,
  confidence_level  NUMERIC,
  current_price     NUMERIC,
  total_stock       INTEGER
)
LANGUAGE sql
STABLE
AS $$
  SELECT t.product_id,t.product_name,t.brand,t.tire_size,t.fitment_position,t.is_oem,
         t.fitment_source,t.confidence_level,t.current_price,t.total_stock
    FROM commerce.find_compatible_tires(
      p_environment,p_vehicle_model_id,p_position,NULL::INTEGER
    ) t;
$$;

COMMENT ON FUNCTION commerce.find_compatible_tires(env_t,uuid,text,integer) IS
  'Retorna pneus compatíveis e, quando informado, restringe pela vigência do ano da moto.';
COMMENT ON FUNCTION commerce.find_compatible_tires(env_t,uuid,text) IS
  'Compatibilidade retroativa sem filtro de ano.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='commerce' AND table_name='vehicle_fitments'
       AND column_name='year_start'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='commerce' AND table_name='vehicle_fitments'
       AND column_name='year_end'
  ) OR to_regprocedure('commerce.find_compatible_tires(env_t,uuid,text,integer)') IS NULL THEN
    RAISE EXCEPTION '0222 falhou: vigência anual de compatibilidade ausente';
  END IF;
END;
$check$;

COMMIT;
