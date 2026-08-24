-- 0206 - Leitura técnica do catálogo no painel moderno parceiro.
-- Somente compatibilidade: nenhuma escrita, custo, estoque ou dado da Matriz.

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    RAISE EXCEPTION '0206: role farejador_partner_app ausente';
  END IF;
  IF to_regclass('commerce.vehicle_models') IS NULL THEN
    RAISE EXCEPTION '0206: commerce.vehicle_models ausente';
  END IF;
  IF to_regclass('commerce.vehicle_fitments') IS NULL THEN
    RAISE EXCEPTION '0206: commerce.vehicle_fitments ausente';
  END IF;
END
$preflight$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON commerce.vehicle_models, commerce.vehicle_fitments
  FROM farejador_partner_app;

GRANT SELECT
  ON commerce.vehicle_models, commerce.vehicle_fitments
  TO farejador_partner_app;

DO $smoke$
DECLARE
  relation_name TEXT;
  forbidden_privilege TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'commerce.vehicle_models',
    'commerce.vehicle_fitments'
  ] LOOP
    IF NOT has_table_privilege('farejador_partner_app', relation_name, 'SELECT') THEN
      RAISE EXCEPTION 'smoke 0206: SELECT ausente em %', relation_name;
    END IF;
    FOREACH forbidden_privilege IN ARRAY ARRAY[
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] LOOP
      IF has_table_privilege(
        'farejador_partner_app', relation_name, forbidden_privilege
      ) THEN
        RAISE EXCEPTION 'smoke 0206: privilegio % indevido em %',
          forbidden_privilege, relation_name;
      END IF;
    END LOOP;
  END LOOP;
END
$smoke$;
