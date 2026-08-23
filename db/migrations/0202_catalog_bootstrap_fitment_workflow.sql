-- ============================================================
-- 0202 - Catálogo antes da primeira compra + homologação de compatibilidade
--
-- Aditiva. Não cria produto, preço, estoque ou compatibilidade automaticamente.
-- O código antigo continua funcionando após esta migration.
-- ============================================================

ALTER TABLE commerce.fitment_discoveries
  ADD COLUMN IF NOT EXISTS discovery_origin TEXT NOT NULL DEFAULT 'conversation',
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS source_title TEXT,
  ADD COLUMN IF NOT EXISTS source_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evidence_summary TEXT,
  ADD COLUMN IF NOT EXISTS suggested_is_oem BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suggested_confidence_level NUMERIC(3,2);

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='commerce.fitment_discoveries'::regclass
       AND conname='fitment_discoveries_origin_check'
  ) THEN
    ALTER TABLE commerce.fitment_discoveries
      ADD CONSTRAINT fitment_discoveries_origin_check
      CHECK (discovery_origin IN ('conversation','web_research','manual'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='commerce.fitment_discoveries'::regclass
       AND conname='fitment_discoveries_source_url_check'
  ) THEN
    ALTER TABLE commerce.fitment_discoveries
      ADD CONSTRAINT fitment_discoveries_source_url_check
      CHECK (source_url IS NULL OR source_url ~* '^https?://');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='commerce.fitment_discoveries'::regclass
       AND conname='fitment_discoveries_suggested_confidence_check'
  ) THEN
    ALTER TABLE commerce.fitment_discoveries
      ADD CONSTRAINT fitment_discoveries_suggested_confidence_check
      CHECK (suggested_confidence_level IS NULL
        OR suggested_confidence_level BETWEEN 0 AND 1);
  END IF;
END
$constraint$;

CREATE INDEX IF NOT EXISTS fitment_discoveries_review_queue_idx
  ON commerce.fitment_discoveries(environment,status,discovered_at DESC)
  WHERE status IN ('pending','approved');

-- O UUID promovido é parte do filme histórico. A validação de existência e de
-- ambiente continua ocorrendo nos triggers quando ele é gravado, mas uma
-- correção posterior pode remover o fitment oficial sem destruir a auditoria.
ALTER TABLE commerce.fitment_discoveries
  DROP CONSTRAINT IF EXISTS fitment_discoveries_promoted_to_fitment_id_fkey;

CREATE TABLE IF NOT EXISTS commerce.fitment_discovery_promotions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   env_t NOT NULL,
  discovery_id  UUID NOT NULL REFERENCES commerce.fitment_discoveries(id),
  fitment_id    UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(environment,discovery_id,fitment_id)
);

DROP TRIGGER IF EXISTS env_match_discovery_promotion_discovery
  ON commerce.fitment_discovery_promotions;
CREATE TRIGGER env_match_discovery_promotion_discovery
  BEFORE INSERT OR UPDATE OF discovery_id ON commerce.fitment_discovery_promotions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'commerce','fitment_discoveries','discovery_id'
  );

DROP TRIGGER IF EXISTS env_match_discovery_promotion_fitment
  ON commerce.fitment_discovery_promotions;
CREATE TRIGGER env_match_discovery_promotion_fitment
  BEFORE INSERT OR UPDATE OF fitment_id ON commerce.fitment_discovery_promotions
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'commerce','vehicle_fitments','fitment_id'
  );

DROP TRIGGER IF EXISTS env_immutable_fitment_discovery_promotions
  ON commerce.fitment_discovery_promotions;
CREATE TRIGGER env_immutable_fitment_discovery_promotions
  BEFORE UPDATE OF environment ON commerce.fitment_discovery_promotions
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_environment_immutable();

CREATE INDEX IF NOT EXISTS fitment_discovery_promotions_discovery_idx
  ON commerce.fitment_discovery_promotions(discovery_id);
CREATE INDEX IF NOT EXISTS fitment_discovery_promotions_fitment_idx
  ON commerce.fitment_discovery_promotions(fitment_id);

COMMENT ON COLUMN commerce.fitment_discoveries.discovery_origin IS
  'Origem da sugestão. web_research continua pendente até aprovação humana.';
COMMENT ON COLUMN commerce.fitment_discoveries.source_url IS
  'URL da evidência consultada; nunca torna a compatibilidade oficial sozinha.';
COMMENT ON TABLE commerce.fitment_discovery_promotions IS
  'Filme da promoção de uma descoberta para todos os tire_specs da mesma medida.';

-- Diagnóstico: deve permanecer vazio. Mostra quando uma associação de medida
-- existe para alguns produtos, mas falta em outro produto ativo da mesma medida.
CREATE OR REPLACE VIEW commerce.catalog_fitment_measure_gaps
WITH (security_invoker=true) AS
WITH specs AS (
  SELECT ts.environment,ts.id AS tire_spec_id,
         regexp_replace(ts.tire_size,'[^0-9]+','','g') AS measure_key
    FROM commerce.tire_specs ts
    JOIN commerce.products p
      ON p.id=ts.product_id AND p.environment=ts.environment
   WHERE p.deleted_at IS NULL AND p.product_type='tire'
), signatures AS (
  SELECT DISTINCT s.environment,s.measure_key,vf.vehicle_model_id,vf.position
    FROM specs s
    JOIN commerce.vehicle_fitments vf
      ON vf.environment=s.environment AND vf.tire_spec_id=s.tire_spec_id
)
SELECT s.environment,s.measure_key,s.tire_spec_id,sg.vehicle_model_id,sg.position
  FROM specs s
  JOIN signatures sg
    ON sg.environment=s.environment AND sg.measure_key=s.measure_key
  LEFT JOIN commerce.vehicle_fitments vf
    ON vf.environment=s.environment AND vf.tire_spec_id=s.tire_spec_id
   AND vf.vehicle_model_id=sg.vehicle_model_id AND vf.position=sg.position
 WHERE vf.id IS NULL;

COMMENT ON VIEW commerce.catalog_fitment_measure_gaps IS
  'Invariante operacional: zero linhas quando compatibilidades estão propagadas por medida.';

-- O app parceiro só precisa ler a especificação para pesquisar o catálogo central
-- pela medida. Nenhuma escrita ou dado financeiro é concedido.
GRANT SELECT ON commerce.tire_specs TO farejador_partner_app;

DO $smoke$
BEGIN
  IF to_regclass('commerce.fitment_discovery_promotions') IS NULL THEN
    RAISE EXCEPTION 'smoke 0202: tabela de promoções ausente';
  END IF;
  IF to_regclass('commerce.catalog_fitment_measure_gaps') IS NULL THEN
    RAISE EXCEPTION 'smoke 0202: view de integridade ausente';
  END IF;
  PERFORM 1 FROM commerce.catalog_fitment_measure_gaps LIMIT 1;
END
$smoke$;
