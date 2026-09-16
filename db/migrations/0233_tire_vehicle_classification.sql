BEGIN;

-- Fundação aditiva. Sem presumir moto pela medida e sem reclassificar históricos.
-- Mantém a unicidade anterior de medida/marca/condição enquanto há consumidores
-- operacionais usando essa chave; duas categorias não podem compartilhar o saldo.
ALTER TABLE commerce.tire_specs ADD COLUMN vehicle_type text
  CHECK (vehicle_type IN ('motorcycle','car'));
ALTER TABLE commerce.vehicle_measure_applications ADD COLUMN vehicle_type text
  CHECK (vehicle_type IN ('motorcycle','car'));
ALTER TABLE commerce.catalog_measure_registrations ADD COLUMN vehicle_type text
  CHECK (vehicle_type IN ('motorcycle','car'));
CREATE INDEX tire_specs_vehicle_type_idx ON commerce.tire_specs(environment,vehicle_type);
COMMENT ON COLUMN commerce.tire_specs.vehicle_type IS
'Tipo confirmado do pneu. NULL = não identificado. Independente de novo/meia-vida/remold e de aplicações homologadas. Sem inferência por aro ou letra R.';

-- Carros exigem homologação do SKU. Uma falta de associação em outra marca
-- não é uma lacuna a preencher automaticamente. Categorias nunca se cruzam.
CREATE OR REPLACE VIEW commerce.catalog_fitment_measure_gaps WITH (security_invoker=true) AS
WITH specs AS (
  SELECT ts.environment,ts.id tire_spec_id,ts.vehicle_type,
    regexp_replace(ts.tire_size,'[^0-9]+','','g') measure_key
  FROM commerce.tire_specs ts JOIN commerce.products p
    ON p.id=ts.product_id AND p.environment=ts.environment
  WHERE p.deleted_at IS NULL AND p.product_type='tire'
    AND ts.vehicle_type IS DISTINCT FROM 'car'
), signatures AS (
  SELECT DISTINCT s.environment,s.measure_key,s.vehicle_type,vf.vehicle_model_id,vf.position
  FROM specs s JOIN commerce.vehicle_fitments vf
    ON vf.environment=s.environment AND vf.tire_spec_id=s.tire_spec_id
)
SELECT s.environment,s.measure_key,s.tire_spec_id,sg.vehicle_model_id,sg.position
FROM specs s JOIN signatures sg ON sg.environment=s.environment AND sg.measure_key=s.measure_key
  AND sg.vehicle_type IS NOT DISTINCT FROM s.vehicle_type
LEFT JOIN commerce.vehicle_fitments vf ON vf.environment=s.environment AND vf.tire_spec_id=s.tire_spec_id
  AND vf.vehicle_model_id=sg.vehicle_model_id AND vf.position=sg.position
WHERE vf.id IS NULL;
COMMENT ON VIEW commerce.catalog_fitment_measure_gaps IS
'Diagnóstico para revisão dentro da mesma categoria. Não autoriza homologação automática; carros exigem validação por SKU.';

-- Mesmo uma escrita fora da API não pode cruzar ambiente ou categoria.
CREATE FUNCTION commerce.guard_fitment_vehicle_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_spec_type text; v_vehicle_type text;
BEGIN
  SELECT vehicle_type INTO v_spec_type FROM commerce.tire_specs
    WHERE id=NEW.tire_spec_id AND environment=NEW.environment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_fitment_environment_mismatch' USING ERRCODE='23514'; END IF;
  SELECT vehicle_type INTO v_vehicle_type FROM commerce.vehicle_models
    WHERE id=NEW.vehicle_model_id AND environment=NEW.environment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_fitment_environment_mismatch' USING ERRCODE='23514'; END IF;
  IF (v_spec_type IS NOT NULL AND v_spec_type<>v_vehicle_type)
    OR (v_spec_type IS NULL AND v_vehicle_type<>'motorcycle') THEN
    RAISE EXCEPTION 'catalog_compatibility_vehicle_type_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fitment_vehicle_type_guard BEFORE INSERT OR UPDATE ON commerce.vehicle_fitments
FOR EACH ROW EXECUTE FUNCTION commerce.guard_fitment_vehicle_type();

CREATE FUNCTION commerce.guard_tire_vehicle_reclassification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.environment IS DISTINCT FROM OLD.environment THEN
    RAISE EXCEPTION 'catalog_spec_environment_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.vehicle_type IS NOT DISTINCT FROM OLD.vehicle_type THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM commerce.vehicle_fitments vf
    JOIN commerce.vehicle_models vm ON vm.id=vf.vehicle_model_id AND vm.environment=vf.environment
    WHERE vf.tire_spec_id=NEW.id AND vf.environment=NEW.environment
      AND ((NEW.vehicle_type IS NOT NULL AND vm.vehicle_type<>NEW.vehicle_type)
        OR (NEW.vehicle_type IS NULL AND vm.vehicle_type<>'motorcycle'))
  ) THEN
    RAISE EXCEPTION 'catalog_spec_vehicle_type_conflicts_with_fitments' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tire_vehicle_reclassification_guard
BEFORE UPDATE OF vehicle_type,environment ON commerce.tire_specs
FOR EACH ROW EXECUTE FUNCTION commerce.guard_tire_vehicle_reclassification();

CREATE FUNCTION commerce.guard_vehicle_model_reclassification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.environment IS NOT DISTINCT FROM OLD.environment
    AND NEW.vehicle_type IS NOT DISTINCT FROM OLD.vehicle_type THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM commerce.vehicle_fitments vf
    JOIN commerce.tire_specs ts ON ts.id=vf.tire_spec_id AND ts.environment=vf.environment
    WHERE vf.vehicle_model_id=OLD.id AND vf.environment=OLD.environment
      AND (NEW.environment<>OLD.environment
        OR (ts.vehicle_type IS NOT NULL AND ts.vehicle_type<>NEW.vehicle_type)
        OR (ts.vehicle_type IS NULL AND NEW.vehicle_type<>'motorcycle'))
  ) THEN
    RAISE EXCEPTION 'catalog_vehicle_type_conflicts_with_fitments' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vehicle_model_reclassification_guard
BEFORE UPDATE OF vehicle_type,environment ON commerce.vehicle_models
FOR EACH ROW EXECUTE FUNCTION commerce.guard_vehicle_model_reclassification();

REVOKE ALL ON FUNCTION commerce.guard_fitment_vehicle_type() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.guard_tire_vehicle_reclassification() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce.guard_vehicle_model_reclassification() FROM PUBLIC;
COMMIT;
