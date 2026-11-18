BEGIN;
-- O nome gerado da chave antiga pode estar abreviado a 63 caracteres.
DO $$
DECLARE old_key name;
BEGIN
  SELECT conname INTO STRICT old_key FROM pg_constraint
   WHERE conrelid='commerce.vehicle_fitments'::regclass AND contype='u'
     AND ARRAY(SELECT attname::text FROM unnest(conkey) WITH ORDINALITY k(num,ord)
               JOIN pg_attribute a ON a.attrelid=conrelid AND a.attnum=k.num ORDER BY k.ord)
         = ARRAY['environment','vehicle_model_id','tire_spec_id','position'];
  EXECUTE format('ALTER TABLE commerce.vehicle_fitments DROP CONSTRAINT %I',old_key);
END $$;
ALTER TABLE commerce.vehicle_fitments ADD CONSTRAINT vehicle_fitments_period_key
  UNIQUE NULLS NOT DISTINCT (environment,vehicle_model_id,tire_spec_id,position,year_start,year_end);

CREATE OR REPLACE VIEW commerce.catalog_fitment_measure_gaps WITH (security_invoker=true) AS
WITH specs AS (
  SELECT ts.environment,ts.id tire_spec_id,ts.vehicle_type,
    regexp_replace(ts.tire_size,'[^0-9]+','','g') measure_key
  FROM commerce.tire_specs ts JOIN commerce.products p
    ON p.id=ts.product_id AND p.environment=ts.environment
  WHERE p.deleted_at IS NULL AND p.product_type='tire'
    AND ts.vehicle_type IS DISTINCT FROM 'car'
), signatures AS (
  SELECT DISTINCT s.environment,s.measure_key,s.vehicle_type,vf.vehicle_model_id,vf.position,vf.year_start,vf.year_end
  FROM specs s JOIN commerce.vehicle_fitments vf
    ON vf.environment=s.environment AND vf.tire_spec_id=s.tire_spec_id
)
SELECT s.environment,s.measure_key,s.tire_spec_id,sg.vehicle_model_id,sg.position,sg.year_start,sg.year_end
FROM specs s JOIN signatures sg ON sg.environment=s.environment AND sg.measure_key=s.measure_key
  AND sg.vehicle_type IS NOT DISTINCT FROM s.vehicle_type
LEFT JOIN commerce.vehicle_fitments vf ON vf.environment=s.environment AND vf.tire_spec_id=s.tire_spec_id
  AND vf.vehicle_model_id=sg.vehicle_model_id AND vf.position=sg.position
  AND vf.year_start IS NOT DISTINCT FROM sg.year_start AND vf.year_end IS NOT DISTINCT FROM sg.year_end
WHERE vf.id IS NULL;
-- Restaura apenas os vínculos comprovadamente sobrescritos no incidente da Twister.
-- Exige as duas promoções sobre o MESMO ID e o registro intacto desde a segunda.
-- Uma remoção ou correção humana posterior não deve ser desfeita.
DO $repair$
DECLARE
  prior commerce.fitment_discoveries%ROWTYPE;
  current_discovery commerce.fitment_discoveries%ROWTYPE;
  overwritten commerce.vehicle_fitments%ROWTYPE;
  restored_id uuid;
BEGIN
  -- Seleciona a evidência já aprovada; em caso de ambiguidade, não decide por aproximação.
  BEGIN
    SELECT d.* INTO STRICT prior FROM commerce.fitment_discoveries d
      JOIN commerce.vehicle_models vm ON vm.environment=d.environment AND vm.id=d.vehicle_model_id
      JOIN commerce.tire_specs ts ON ts.environment=d.environment AND ts.id=d.tire_spec_id
     WHERE d.environment='prod' AND vm.make='Honda' AND vm.model='CB 250F Twister'
       AND ts.vehicle_type='motorcycle' AND ts.tire_size='140/70-17' AND d.position='rear'
       AND d.status='promoted' AND d.suggested_year_start=2016 AND d.suggested_year_end=2017
       AND d.source_url='https://www.honda.com.br/motos/sites/hda/files/2017-05/Folheto%20Twister_Ok.pdf'
     FOR UPDATE OF d;
    SELECT d.* INTO STRICT current_discovery FROM commerce.fitment_discoveries d
     WHERE d.environment=prior.environment AND d.vehicle_model_id=prior.vehicle_model_id
       AND d.position=prior.position AND d.status='promoted' AND d.reviewed_at>prior.reviewed_at
       AND d.suggested_year_start=2022 AND d.suggested_year_end=2022
       AND d.source_url='https://saladeimprensa.honda.com.br/releases/honda-cb-twister-2022-lider-da-categoria';
  EXCEPTION WHEN NO_DATA_FOUND THEN RETURN;
  END;
  FOR overwritten IN
    SELECT vf.* FROM commerce.vehicle_fitments vf
    JOIN commerce.tire_specs ts ON ts.id=vf.tire_spec_id AND ts.environment=vf.environment
    JOIN commerce.products p ON p.id=ts.product_id AND p.environment=ts.environment
    JOIN commerce.fitment_discovery_promotions a ON a.environment=vf.environment AND a.fitment_id=vf.id
    JOIN commerce.fitment_discovery_promotions b ON b.environment=vf.environment AND b.fitment_id=vf.id
    WHERE vf.environment=prior.environment AND a.discovery_id=prior.id AND b.discovery_id=current_discovery.id
      AND vf.vehicle_model_id=prior.vehicle_model_id AND vf.position=prior.position
      AND ts.tire_size='140/70-17' AND ts.vehicle_type='motorcycle' AND p.deleted_at IS NULL
      AND vf.source='discovery_promoted' AND vf.year_start=2022 AND vf.year_end=2022
      AND vf.updated_at=current_discovery.reviewed_at
    ORDER BY vf.id FOR UPDATE OF vf
  LOOP
    INSERT INTO commerce.vehicle_fitments(environment,vehicle_model_id,tire_spec_id,position,
      year_start,year_end,is_oem,source,confidence_level)
    VALUES(prior.environment,prior.vehicle_model_id,overwritten.tire_spec_id,prior.position,
      prior.suggested_year_start,prior.suggested_year_end,prior.suggested_is_oem,'discovery_promoted',
      coalesce(prior.suggested_confidence_level,0.8))
    ON CONFLICT ON CONSTRAINT vehicle_fitments_period_key DO NOTHING RETURNING id INTO restored_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    INSERT INTO commerce.fitment_discovery_promotions(environment,discovery_id,fitment_id)
      VALUES(prior.environment,prior.id,restored_id);
    IF overwritten.id=prior.promoted_to_fitment_id THEN
      UPDATE commerce.fitment_discoveries SET promoted_to_fitment_id=restored_id
       WHERE environment=prior.environment AND id=prior.id;
    END IF;
    INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
      VALUES(prior.environment,'catalog','commerce.vehicle_fitments',restored_id,'catalog_fitment_period_restored',
        'migration 0294',jsonb_build_object('discovery_id',prior.id,'preserved_fitment_id',overwritten.id,
        'year_start',prior.suggested_year_start,'year_end',prior.suggested_year_end));
  END LOOP;
END $repair$;
COMMIT;
