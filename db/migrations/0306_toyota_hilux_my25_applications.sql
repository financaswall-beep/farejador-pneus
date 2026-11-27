BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Fichas brasileiras do ano-modelo 2025. São dimensões originais por eixo,
-- independentes do estoque e da homologação de um produto comercial.
DO $$
DECLARE
  spec record;
  vehicle_id uuid;
  axle text;
  application_key text;
  vehicle_name text;
  source_link text;
  search_names text[];
  nominal_measure text;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('Power Pack MT', 'Cabine Dupla', '265/65R17'),
    ('Power Pack AT', 'Cabine Dupla', '265/65R17'),
    ('SR',            'Cabine Dupla', '265/65R17'),
    ('SRV',           'Cabine Dupla', '265/60R18'),
    ('SRX',           'Cabine Dupla', '265/60R18'),
    ('SRX Plus',      'Cabine Dupla', '265/60R18'),
    ('Cabine Simples Manual',     'Cabine Simples', '225/70R17'),
    ('Cabine Simples Automático', 'Cabine Simples', '225/70R17'),
    ('Chassi Manual',             'Chassi',         '225/70R17'),
    ('Chassi Automático',         'Chassi',         '225/70R17')
  ) AS configurations(variant,body,tire_size) LOOP
    source_link := CASE WHEN spec.body='Cabine Dupla'
      THEN 'https://media.toyota.com.br/0a63079c-ec07-4607-a6b0-b0d182bda6b4.pdf'
      ELSE 'https://media.toyota.com.br/39ba3db5-9ea2-42c7-8b60-f10b61c34306.pdf' END;
    vehicle_name := 'Hilux ' || spec.variant;
    nominal_measure := replace(spec.tire_size,'R','-');
    search_names := ARRAY['Hilux ' || spec.body];
    IF spec.body='Cabine Dupla' THEN
      search_names := array_append(search_names,'Hilux Cabine Dupla ' || spec.variant);
    END IF;

    -- Se já houver uma versão equivalente, reaproveite seu ID. Colisões de
    -- vigência ou cadastros arquivados precisam de revisão da Matriz.
    vehicle_id := (
      SELECT id FROM commerce.vehicle_models WHERE environment='prod' AND vehicle_type='car'
        AND lower(trim(make))='toyota' AND lower(trim(model))='hilux'
        AND lower(trim(variant))=lower(spec.variant)
        AND 2025 BETWEEN coalesce(year_start,1900) AND coalesce(year_end,2100)
    );
    IF vehicle_id IS NULL THEN
      INSERT INTO commerce.vehicle_models(environment,vehicle_type,make,model,variant,year_start,year_end,aliases)
        VALUES('prod','car','Toyota','Hilux',spec.variant,2025,2025,search_names) RETURNING id INTO vehicle_id;
    ELSIF EXISTS (SELECT 1 FROM commerce.vehicle_models WHERE id=vehicle_id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Versão arquivada da Hilux requer revisão: %',spec.variant;
    END IF;

    FOREACH axle IN ARRAY ARRAY['front','rear'] LOOP
      application_key := concat_ws(':','car',vehicle_id,2025,2025,axle,nominal_measure);
      INSERT INTO commerce.vehicle_measure_applications
        (environment,application_id,vehicle_type,make,model,aliases,position,tire_size,display_measure,
         year_start,year_end,status,application_kind,reference,import_batch)
      VALUES ('prod',application_key,'car','Toyota',vehicle_name,search_names,axle,spec.tire_size,nominal_measure,
        2025,2025,'verified','original',jsonb_build_object(
          'vehicle_model_id',vehicle_id,'vehicle_variant',spec.variant,'reference_model',vehicle_name,
          'reference_year_start',2025,'reference_year_end',2025,'year_reference','2025',
          'range_source_urls',jsonb_build_array(source_link),'source_url',source_link,
          'source_type','Ficha técnica Toyota do Brasil','source_checked_at','2026-11-26',
          'index_spec',NULL,'mounting','ND','notes','','validation_scope','manufacturer_measure',
          'product_fitment_confirmed',false), 'toyota-br-hilux-my25')
      ON CONFLICT (environment,application_id) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
COMMIT;
