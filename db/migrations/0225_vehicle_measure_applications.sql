-- Aplicações por medida: sobrevivem à exclusão de produtos e não homologam SKUs.
CREATE TABLE commerce.vehicle_measure_applications (
  environment env_t NOT NULL,
  application_id text NOT NULL,
  make text NOT NULL,
  model text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  position text NOT NULL CHECK (position IN ('front','rear')),
  tire_size text NOT NULL,
  display_measure text NOT NULL,
  year_start integer CHECK (year_start BETWEEN 1900 AND 2100),
  year_end integer CHECK (year_end BETWEEN 1900 AND 2100),
  status text NOT NULL CHECK (status IN ('verified','pending','rejected')),
  application_kind text NOT NULL CHECK (application_kind IN ('original','alternative','unknown')),
  reference jsonb NOT NULL CHECK (jsonb_typeof(reference)='object'),
  review_note text NOT NULL DEFAULT '',
  import_batch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment,application_id),
  CHECK (year_start IS NULL OR year_end IS NULL OR year_start<=year_end),
  CHECK (status<>'verified' OR (application_kind='original'
    AND length(COALESCE(reference->>'source_url',''))>0))
);
CREATE INDEX vehicle_measure_applications_measure
  ON commerce.vehicle_measure_applications(environment,display_measure,status);
ALTER TABLE commerce.vehicle_measure_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.vehicle_measure_applications FROM PUBLIC;
-- Catálogo técnico público; parceiros só podem ler aplicações verificadas.
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON commerce.vehicle_measure_applications FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    GRANT SELECT ON commerce.vehicle_measure_applications TO farejador_partner_app;
    CREATE POLICY partner_verified_applications ON commerce.vehicle_measure_applications
      FOR SELECT TO farejador_partner_app USING (status='verified' AND application_kind='original'
        AND environment::text = (SELECT pu.environment::text FROM network.partner_units pu
          WHERE pu.id=network.current_partner_unit()));
  END IF;
END $$;
COMMENT ON TABLE commerce.vehicle_measure_applications IS
'Aplicações técnicas por moto, medida, posição e vigência comprovada. Sem estoque, preços ou vínculo obrigatório com SKU. Pendências não são usadas pelo bot. Anos nulos não comprovam vigência universal.';
