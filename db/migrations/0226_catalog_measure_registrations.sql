-- Pré-cadastro por medida. Não cria SKU, preço, saldo ou disponibilidade.
CREATE TABLE commerce.catalog_measure_registrations (
  environment env_t NOT NULL,
  measure text NOT NULL CHECK (measure ~ '^(?:[0-9]{2,3}/[0-9]{2,3}|[0-9][.][0-9]{2})-[0-9]{2}$'),
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment,measure)
);
ALTER TABLE commerce.catalog_measure_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce.catalog_measure_registrations FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','farejador_partner_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON commerce.catalog_measure_registrations FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMENT ON TABLE commerce.catalog_measure_registrations IS
'Medidas solicitadas para cadastro. Marca e condição são preenchidas ao criar o produto. Aplicações, anos e posições permanecem em vehicle_measure_applications. Não representa estoque.';
-- Documento fornecido em 2026-09-11: 24 medidas principais e 59 adicionais distintas.
-- Deduplicação pelo conteúdo, sem importar marcas, custos ou saldos de outra base.
INSERT INTO commerce.catalog_measure_registrations(environment,measure,source)
SELECT 'prod'::env_t,measure,'lista-fornecida-20260911'
FROM (VALUES
  ('100/80-14'),
  ('100/80-16'),
  ('100/80-17'),
  ('100/80-18'),
  ('100/90-10'),
  ('100/90-12'),
  ('100/90-14'),
  ('100/90-18'),
  ('100/90-19'),
  ('110/70-13'),
  ('110/70-14'),
  ('110/70-16'),
  ('110/70-17'),
  ('110/80-14'),
  ('110/80-17'),
  ('110/80-18'),
  ('110/80-19'),
  ('110/90-10'),
  ('110/90-12'),
  ('110/90-16'),
  ('110/90-17'),
  ('120/70-14'),
  ('120/70-15'),
  ('120/70-17'),
  ('120/70-18'),
  ('120/70-19'),
  ('120/80-14'),
  ('120/80-16'),
  ('120/80-17'),
  ('120/80-18'),
  ('120/90-17'),
  ('130/70-13'),
  ('130/70-16'),
  ('130/70-17'),
  ('130/80-17'),
  ('130/80-18'),
  ('130/90-16'),
  ('140/60-13'),
  ('140/60-17'),
  ('140/70-14'),
  ('140/70-16'),
  ('140/70-17'),
  ('140/80-17'),
  ('140/90-15'),
  ('150/60-17'),
  ('150/70-13'),
  ('150/70-14'),
  ('150/70-17'),
  ('150/80-16'),
  ('160/60-14'),
  ('160/60-17'),
  ('170/60-17'),
  ('170/80-15'),
  ('180/55-17'),
  ('180/55-18'),
  ('180/70-15'),
  ('190/50-17'),
  ('190/55-17'),
  ('2.50-17'),
  ('2.75-17'),
  ('2.75-18'),
  ('200/60-17'),
  ('3.00-17'),
  ('3.50-10'),
  ('3.50-16'),
  ('60/100-17'),
  ('70/90-17'),
  ('80/100-14'),
  ('80/100-18'),
  ('80/100-21'),
  ('80/80-14'),
  ('80/90-18'),
  ('80/90-21'),
  ('90/80-14'),
  ('90/80-16'),
  ('90/90-10'),
  ('90/90-12'),
  ('90/90-14'),
  ('90/90-16'),
  ('90/90-17'),
  ('90/90-18'),
  ('90/90-19'),
  ('90/90-21')
) AS supplied(measure)
ON CONFLICT (environment,measure) DO NOTHING;
