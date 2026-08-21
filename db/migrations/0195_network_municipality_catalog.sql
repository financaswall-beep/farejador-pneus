-- 0195 - Catálogo oficial de municípios atendidos pela Rede.
-- Impede que erro de digitação crie uma "cidade" diferente em produção.

CREATE TABLE IF NOT EXISTS network.municipality_catalog (
  municipality_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  state_code CHAR(2) NOT NULL DEFAULT 'RJ' CHECK (state_code='RJ'),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO network.municipality_catalog (municipality_key,display_name)
VALUES
  ('angra dos reis','Angra dos Reis'),
  ('aperibe','Aperibé'),
  ('araruama','Araruama'),
  ('areal','Areal'),
  ('armacao dos buzios','Armação dos Búzios'),
  ('arraial do cabo','Arraial do Cabo'),
  ('barra do pirai','Barra do Piraí'),
  ('barra mansa','Barra Mansa'),
  ('belford roxo','Belford Roxo'),
  ('bom jardim','Bom Jardim'),
  ('bom jesus do itabapoana','Bom Jesus do Itabapoana'),
  ('cabo frio','Cabo Frio'),
  ('cachoeiras de macacu','Cachoeiras de Macacu'),
  ('cambuci','Cambuci'),
  ('campos dos goytacazes','Campos dos Goytacazes'),
  ('cantagalo','Cantagalo'),
  ('carapebus','Carapebus'),
  ('cardoso moreira','Cardoso Moreira'),
  ('carmo','Carmo'),
  ('casimiro de abreu','Casimiro de Abreu'),
  ('comendador levy gasparian','Comendador Levy Gasparian'),
  ('conceicao de macabu','Conceição de Macabu'),
  ('cordeiro','Cordeiro'),
  ('duas barras','Duas Barras'),
  ('duque de caxias','Duque de Caxias'),
  ('engenheiro paulo de frontin','Engenheiro Paulo de Frontin'),
  ('guapimirim','Guapimirim'),
  ('iguaba grande','Iguaba Grande'),
  ('itaborai','Itaboraí'),
  ('itaguai','Itaguaí'),
  ('italva','Italva'),
  ('itaocara','Itaocara'),
  ('itaperuna','Itaperuna'),
  ('itatiaia','Itatiaia'),
  ('japeri','Japeri'),
  ('laje do muriae','Laje do Muriaé'),
  ('macae','Macaé'),
  ('macuco','Macuco'),
  ('mage','Magé'),
  ('mangaratiba','Mangaratiba'),
  ('marica','Maricá'),
  ('mendes','Mendes'),
  ('mesquita','Mesquita'),
  ('miguel pereira','Miguel Pereira'),
  ('miracema','Miracema'),
  ('natividade','Natividade'),
  ('nilopolis','Nilópolis'),
  ('niteroi','Niterói'),
  ('nova friburgo','Nova Friburgo'),
  ('nova iguacu','Nova Iguaçu'),
  ('paracambi','Paracambi'),
  ('paraiba do sul','Paraíba do Sul'),
  ('paraty','Paraty'),
  ('paty do alferes','Paty do Alferes'),
  ('petropolis','Petrópolis'),
  ('pinheiral','Pinheiral'),
  ('pirai','Piraí'),
  ('porciuncula','Porciúncula'),
  ('porto real','Porto Real'),
  ('quatis','Quatis'),
  ('queimados','Queimados'),
  ('quissama','Quissamã'),
  ('resende','Resende'),
  ('rio bonito','Rio Bonito'),
  ('rio claro','Rio Claro'),
  ('rio das flores','Rio das Flores'),
  ('rio das ostras','Rio das Ostras'),
  ('rio de janeiro','Rio de Janeiro'),
  ('santa maria madalena','Santa Maria Madalena'),
  ('santo antonio de padua','Santo Antônio de Pádua'),
  ('sao fidelis','São Fidélis'),
  ('sao francisco de itabapoana','São Francisco de Itabapoana'),
  ('sao goncalo','São Gonçalo'),
  ('sao joao da barra','São João da Barra'),
  ('sao joao de meriti','São João de Meriti'),
  ('sao jose de uba','São José de Ubá'),
  ('sao jose do vale do rio preto','São José do Vale do Rio Preto'),
  ('sao pedro da aldeia','São Pedro da Aldeia'),
  ('sao sebastiao do alto','São Sebastião do Alto'),
  ('sapucaia','Sapucaia'),
  ('saquarema','Saquarema'),
  ('seropedica','Seropédica'),
  ('silva jardim','Silva Jardim'),
  ('sumidouro','Sumidouro'),
  ('tangua','Tanguá'),
  ('teresopolis','Teresópolis'),
  ('trajano de moraes','Trajano de Moraes'),
  ('tres rios','Três Rios'),
  ('valenca','Valença'),
  ('varre-sai','Varre-Sai'),
  ('vassouras','Vassouras'),
  ('volta redonda','Volta Redonda')
ON CONFLICT (municipality_key) DO UPDATE
  SET display_name=EXCLUDED.display_name,active=true,updated_at=now();

REVOKE ALL ON network.municipality_catalog FROM PUBLIC;

CREATE OR REPLACE FUNCTION network.guard_supported_municipality()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,network
AS $function$
BEGIN
  -- Fixtures de teste podem usar nomes sintéticos; produção nunca.
  IF NEW.environment='prod'
     AND NOT EXISTS (
       SELECT 1
         FROM network.municipality_catalog catalog
        WHERE catalog.municipality_key=NEW.municipio AND catalog.active
     ) THEN
    RAISE EXCEPTION 'unsupported_network_municipality:%',NEW.municipio
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION network.guard_supported_municipality() FROM PUBLIC;

DROP TRIGGER IF EXISTS unit_coverage_supported_municipality
  ON network.unit_coverage;
CREATE TRIGGER unit_coverage_supported_municipality
BEFORE INSERT OR UPDATE OF environment,municipio
ON network.unit_coverage
FOR EACH ROW EXECUTE FUNCTION network.guard_supported_municipality();

COMMENT ON TABLE network.municipality_catalog IS
  'Municípios oficiais do RJ aceitos como cobertura da Rede; chave sem acento casa com unit_coverage.municipio.';
