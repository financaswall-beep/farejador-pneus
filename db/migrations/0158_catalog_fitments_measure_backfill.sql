-- 0158_catalog_fitments_measure_backfill.sql
-- Compatibilidade pertence a medida. Garante que todo produto ativo da mesma
-- medida possua os mesmos vinculos exatos usados pelo catalogo e pelo bot.

WITH candidates AS (
  SELECT DISTINCT ON (
    target_spec.environment,
    target_spec.id,
    source_fitment.vehicle_model_id,
    source_fitment.position
  )
    target_spec.environment,
    source_fitment.vehicle_model_id,
    target_spec.id AS tire_spec_id,
    source_fitment.position,
    source_fitment.is_oem,
    source_fitment.source,
    source_fitment.confidence_level
  FROM commerce.products target_product
  JOIN commerce.tire_specs target_spec
    ON target_spec.product_id=target_product.id
   AND target_spec.environment=target_product.environment
  JOIN commerce.tire_specs source_spec
    ON source_spec.environment=target_spec.environment
   AND source_spec.id<>target_spec.id
   AND regexp_replace(source_spec.tire_size,'[^0-9]+','','g')
       =regexp_replace(target_spec.tire_size,'[^0-9]+','','g')
  JOIN commerce.vehicle_fitments source_fitment
    ON source_fitment.tire_spec_id=source_spec.id
   AND source_fitment.environment=source_spec.environment
  WHERE target_product.deleted_at IS NULL
    AND target_product.product_type='tire'
  ORDER BY
    target_spec.environment,
    target_spec.id,
    source_fitment.vehicle_model_id,
    source_fitment.position,
    source_fitment.is_oem DESC,
    source_fitment.confidence_level DESC NULLS LAST,
    source_fitment.created_at
)
INSERT INTO commerce.vehicle_fitments (
  environment,
  vehicle_model_id,
  tire_spec_id,
  position,
  is_oem,
  source,
  confidence_level
)
SELECT
  environment,
  vehicle_model_id,
  tire_spec_id,
  position,
  is_oem,
  source,
  confidence_level
FROM candidates
ON CONFLICT (environment,vehicle_model_id,tire_spec_id,position) DO NOTHING;

DO $check$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM commerce.products target_product
    JOIN commerce.tire_specs target_spec
      ON target_spec.product_id=target_product.id
     AND target_spec.environment=target_product.environment
    WHERE target_product.deleted_at IS NULL
      AND target_product.product_type='tire'
      AND EXISTS (
        SELECT 1
        FROM commerce.tire_specs source_spec
        JOIN commerce.vehicle_fitments source_fitment
          ON source_fitment.tire_spec_id=source_spec.id
         AND source_fitment.environment=source_spec.environment
        WHERE source_spec.environment=target_spec.environment
          AND regexp_replace(source_spec.tire_size,'[^0-9]+','','g')
              =regexp_replace(target_spec.tire_size,'[^0-9]+','','g')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM commerce.vehicle_fitments target_fitment
        WHERE target_fitment.environment=target_spec.environment
          AND target_fitment.tire_spec_id=target_spec.id
      )
  ) THEN
    RAISE EXCEPTION '0158 falhou: produto ativo continuou sem compatibilidade conhecida da medida';
  END IF;
END;
$check$;
