-- 0138 — Etapa 6 / Fatia 6.3: uma candidatura cria no máximo uma unidade.
-- Garantias físicas complementam a transação/idempotência do backend.

ALTER TABLE network.partner_applications
  ADD CONSTRAINT partner_applications_environment_id_uniq UNIQUE (environment, id);

ALTER TABLE network.partner_units
  ADD CONSTRAINT partner_units_environment_id_uniq UNIQUE (environment, id);

ALTER TABLE network.partner_units
  ADD COLUMN IF NOT EXISTS source_application_id UUID;

ALTER TABLE network.partner_units
  ADD CONSTRAINT partner_units_source_application_fk
  FOREIGN KEY (environment, source_application_id)
  REFERENCES network.partner_applications (environment, id);

CREATE UNIQUE INDEX IF NOT EXISTS partner_units_source_application_uniq
  ON network.partner_units (environment, source_application_id)
  WHERE source_application_id IS NOT NULL;

ALTER TABLE network.partner_applications
  ADD CONSTRAINT partner_applications_created_unit_fk
  FOREIGN KEY (environment, created_partner_unit_id)
  REFERENCES network.partner_units (environment, id);

CREATE UNIQUE INDEX IF NOT EXISTS partner_applications_created_unit_uniq
  ON network.partner_applications (environment, created_partner_unit_id)
  WHERE created_partner_unit_id IS NOT NULL;

COMMENT ON COLUMN network.partner_units.source_application_id IS
  'Candidatura causal que originou a unidade. UNIQUE parcial garante uma unidade por candidatura.';

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM network.partner_applications
    WHERE status='approved' AND created_partner_unit_id IS NULL
  ) THEN
    RAISE EXCEPTION 'stage6_approved_application_without_unit';
  END IF;
END
$verify$;

-- Rollback manual:
-- ALTER TABLE network.partner_applications DROP CONSTRAINT partner_applications_created_unit_fk;
-- DROP INDEX network.partner_applications_created_unit_uniq;
-- ALTER TABLE network.partner_units DROP CONSTRAINT partner_units_source_application_fk;
-- DROP INDEX network.partner_units_source_application_uniq;
-- ALTER TABLE network.partner_units DROP COLUMN source_application_id;
