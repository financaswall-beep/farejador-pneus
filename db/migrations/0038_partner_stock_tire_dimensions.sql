-- ============================================================
-- 0038_partner_stock_tire_dimensions.sql
-- Estoque do parceiro ganha dimensões separadas (largura/perfil/aro).
--
-- Motivo:
--   commerce.tire_specs (catalogo central) ja guarda width_mm/
--   aspect_ratio/rim_diameter alem de tire_size. commerce.partner_
--   stock_levels guardava apenas a string "tire_size", impossibilitando
--   busca dimensional ("todo pneu aro 17 da rede") sem LIKE lento +
--   falso positivo ("117" casa com "%-17").
--
--   Frontend do portal parceiro agora captura os 3 numeros separados,
--   entao faz sentido persistir nas 3 colunas tambem.
--
-- O que esta migration faz:
--   1. Adiciona tire_width_mm, tire_aspect_ratio, tire_rim_diameter
--      em commerce.partner_stock_levels
--   2. Cria indice composto pra busca dimensional
--   3. Backfill regex-based dos registros existentes com tire_size
--      no padrao canonico (90/90-18, com tolerancia a 150/60R17 e
--      150/60ZR17)
--
-- Invariantes:
--   - tire_size continua sendo a fonte de verdade textual
--   - As 3 colunas dimensionais sao redundancia indexavel
--   - Quando string nao bate o regex (variantes legadas livres),
--     as 3 colunas ficam NULL — nao tenta adivinhar
--
-- Assinatura: Claude (Opus 4.7), 2026-05-19
-- ============================================================

ALTER TABLE commerce.partner_stock_levels
  ADD COLUMN IF NOT EXISTS tire_width_mm     INTEGER,
  ADD COLUMN IF NOT EXISTS tire_aspect_ratio INTEGER,
  ADD COLUMN IF NOT EXISTS tire_rim_diameter INTEGER;

COMMENT ON COLUMN commerce.partner_stock_levels.tire_width_mm IS
  'Largura nominal em mm (extraida da string tire_size). Ex: 90 em "90/90-18".';
COMMENT ON COLUMN commerce.partner_stock_levels.tire_aspect_ratio IS
  'Relacao de aspecto / perfil em % (segundo numero da medida). Ex: 90 em "90/90-18".';
COMMENT ON COLUMN commerce.partner_stock_levels.tire_rim_diameter IS
  'Diametro do aro em polegadas. Ex: 18 em "90/90-18".';

CREATE INDEX IF NOT EXISTS partner_stock_levels_tire_dim_idx
  ON commerce.partner_stock_levels (tire_width_mm, tire_aspect_ratio, tire_rim_diameter)
  WHERE deleted_at IS NULL;

-- Backfill: parseia tire_size dos registros existentes.
-- Suporta:
--   90/90-18      (metrico padrao)
--   100/80-17     (metrico padrao)
--   150/60R17     (radial)
--   150/60ZR17    (radial high-performance)
-- Registros que nao casam ficam com dimensoes NULL (intencional).
UPDATE commerce.partner_stock_levels
SET tire_width_mm     = (regexp_match(tire_size, '^(\d{2,3})/'))[1]::INTEGER,
    tire_aspect_ratio = (regexp_match(tire_size, '/(\d{2,3})[-ZR]'))[1]::INTEGER,
    tire_rim_diameter = (regexp_match(tire_size, '(\d{1,2})$'))[1]::INTEGER
WHERE tire_size IS NOT NULL
  AND tire_size ~ '^\d{2,3}/\d{2,3}[-ZR]+\d{1,2}$'
  AND tire_width_mm IS NULL;
