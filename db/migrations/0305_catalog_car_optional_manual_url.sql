BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- A Matriz pode cadastrar a aplicação de um carro mesmo sem o link do manual.
ALTER TABLE commerce.vehicle_measure_applications
  DROP CONSTRAINT vehicle_measure_applications_check1,
  ADD CONSTRAINT vehicle_measure_applications_verified_source CHECK (
    status <> 'verified' OR (
      application_kind = 'original' AND (
        length(COALESCE(reference->>'source_url', '')) > 0
        OR (
          vehicle_type IS NOT DISTINCT FROM 'car'
          AND import_batch = 'matriz-car-manual'
          AND reference @> '{"validation_scope":"catalog_measure"}'::jsonb
        )
      )
    )
  );

COMMIT;
