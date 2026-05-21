-- ============================================================
-- 0039_commerce_network_stock_unified.sql
-- View consolidada de estoque: matriz + parceiros.
--
-- Motivo:
--   Hoje commerce.stock_levels (matriz) e commerce.partner_stock_levels
--   (parceiros credenciados) sao tabelas separadas com schemas diferentes.
--   Painel admin que precisa "estoque da rede inteira" fazia UNION manual
--   com colunas remapeadas. Esta view padroniza a leitura.
--
--   O bot da Atendente, quando responde "tenho esse pneu?", consulta
--   commerce.stock_levels da matriz e nao enxerga estoque dos parceiros.
--   Quando a integracao admin<->parceiro entrar na Fase 2, esta view e
--   o ponto de leitura unificado.
--
-- O que esta migration faz:
--   1. Cria view commerce.network_stock_unified
--   2. Schema padronizado: location_type, unit_id, product_id, item_name,
--      tire_size, dimensoes, brand, quantity_available, stock_status
--   3. Status derivado pro estoque da matriz (que nao tem stock_status nativo)
--
-- Invariantes:
--   - View read-only. Mutacoes continuam indo nas tabelas originais.
--   - Matriz nao tem conceito de unit_id — vira NULL na view.
--   - Matriz nao tem is_tracked — assume true (sempre rastreado).
--   - Items deletados (deleted_at NOT NULL) ficam fora.
--
-- Assinatura: Claude (Opus 4.7), 2026-05-19
-- ============================================================

CREATE OR REPLACE VIEW commerce.network_stock_unified AS

-- ─────────────────────────────────────────────
-- Estoque da matriz (commerce.stock_levels)
-- ─────────────────────────────────────────────
SELECT
  'matriz'::text                       AS location_type,
  NULL::uuid                           AS unit_id,
  NULL::text                           AS unit_slug,
  'Matriz'::text                       AS unit_label,
  sl.environment,
  sl.product_id,
  p.product_code,
  p.product_name                       AS item_name,
  ts.tire_size,
  ts.width_mm                          AS tire_width_mm,
  ts.aspect_ratio                      AS tire_aspect_ratio,
  ts.rim_diameter                      AS tire_rim_diameter,
  p.brand,
  sl.quantity_available,
  CASE
    WHEN sl.quantity_available <= 0 THEN 'out_of_stock'
    WHEN sl.quantity_available < 5  THEN 'low_stock'
    ELSE 'in_stock'
  END                                  AS stock_status,
  true                                 AS is_tracked,
  sl.updated_at
FROM commerce.stock_levels sl
JOIN commerce.products p
  ON p.id = sl.product_id
 AND p.environment = sl.environment
 AND p.deleted_at IS NULL
LEFT JOIN commerce.tire_specs ts
  ON ts.product_id = p.id
 AND ts.environment = p.environment

UNION ALL

-- ─────────────────────────────────────────────
-- Estoque dos parceiros (commerce.partner_stock_levels)
-- ─────────────────────────────────────────────
SELECT
  'partner'::text                      AS location_type,
  ps.unit_id,
  pu.slug                              AS unit_slug,
  pu.display_name                      AS unit_label,
  ps.environment,
  ps.product_id,
  COALESCE(p.product_code, ps.local_sku) AS product_code,
  ps.item_name,
  ps.tire_size,
  ps.tire_width_mm,
  ps.tire_aspect_ratio,
  ps.tire_rim_diameter,
  ps.brand,
  COALESCE(ps.quantity_on_hand, 0)     AS quantity_available,
  ps.stock_status,
  ps.is_tracked,
  ps.updated_at
FROM commerce.partner_stock_levels ps
JOIN network.partner_units pu
  ON pu.id = ps.unit_id
 AND pu.environment = ps.environment
 AND pu.deleted_at IS NULL
LEFT JOIN commerce.products p
  ON p.id = ps.product_id
 AND p.environment = ps.environment
WHERE ps.deleted_at IS NULL;

COMMENT ON VIEW commerce.network_stock_unified IS
  'Estoque consolidado da rede: matriz + parceiros credenciados. Padroniza schema pra leitura cruzada. Mutacoes vao direto nas tabelas originais (commerce.stock_levels, commerce.partner_stock_levels). Items deletados sao excluidos.';
