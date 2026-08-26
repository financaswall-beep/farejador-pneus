BEGIN;

-- O estoque continua transacional por (medida, marca, condição). Esta tabela
-- guarda somente a política de reposição, em que marcas são substituíveis.
CREATE TABLE commerce.wholesale_replenishment_policies (
  environment env_t NOT NULL,
  measure TEXT NOT NULL CHECK (length(btrim(measure)) BETWEEN 1 AND 60),
  tire_condition TEXT NOT NULL
    CHECK (tire_condition IN ('meia_vida','novo','remold')),
  min_quantity INTEGER NOT NULL CHECK (min_quantity >= 0),
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, measure, tire_condition)
);

-- O maior mínimo existente é o fallback conservador. Somar mínimos de marcas
-- duplicaria a necessidade da medida e poderia gerar compras excessivas.
INSERT INTO commerce.wholesale_replenishment_policies
  (environment,measure,tire_condition,min_quantity,updated_by)
SELECT environment,measure,tire_condition,max(min_quantity),'migration:0209'
  FROM commerce.wholesale_stock
 WHERE min_quantity IS NOT NULL
 GROUP BY environment,measure,tire_condition;

-- Mantém consumidores legados coerentes enquanto a política agregada passa a
-- ser a fonte do plano, do sino e da apresentação do mínimo no galpão.
UPDATE commerce.wholesale_stock s
   SET min_quantity=p.min_quantity
  FROM commerce.wholesale_replenishment_policies p
 WHERE p.environment=s.environment AND p.measure=s.measure
   AND p.tire_condition=s.tire_condition
   AND s.min_quantity IS DISTINCT FROM p.min_quantity;

CREATE TRIGGER wholesale_replenishment_policies_set_updated_at
BEFORE UPDATE ON commerce.wholesale_replenishment_policies
FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

CREATE TRIGGER env_immutable_wholesale_replenishment_policies
BEFORE UPDATE OF environment ON commerce.wholesale_replenishment_policies
FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

REVOKE ALL ON commerce.wholesale_replenishment_policies FROM PUBLIC;
DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    EXECUTE 'REVOKE ALL ON commerce.wholesale_replenishment_policies FROM farejador_partner_app';
    IF has_table_privilege(
      'farejador_partner_app','commerce.wholesale_replenishment_policies','SELECT'
    ) THEN
      RAISE EXCEPTION '0209: política de reposição da Matriz exposta ao parceiro';
    END IF;
  END IF;
END;
$security$;

COMMENT ON TABLE commerce.wholesale_replenishment_policies IS
  '0209: mínimo da Matriz por medida+condição. Marcas somam apenas no planejamento; estoque, custo e compra permanecem por variante exata.';

COMMIT;
