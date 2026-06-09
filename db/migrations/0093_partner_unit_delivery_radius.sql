-- 0093: Raio de ENTREGA por loja (km) em network.partner_units.
--       Fundação da PROXIMIDADE-PRIMEIRO (Fase 0). Ver
--       docs/SESSAO_2026-06-09b_PROXIMIDADE_HANDOFF.md §2.4/§2.5.
--
-- 100% ADITIVA / RETROCOMPATÍVEL: só ADD COLUMN IF NOT EXISTS. ZERO DROP de dado.
-- DORMANTE: NENHUMA coluna nova é lida pelo código das Fases 0 e 1 (retirada não usa
-- raio). É consumida só na Fase 3 (entrega por proximidade), quando a loja só entra na
-- entrega se tiver o raio preenchido E a distância ≤ raio. Até lá é invisível e inofensiva.
--
--   delivery_radius_km = até quantos km a loja topa ENTREGAR (decisão Wallace 2026-06-09:
--               número livre que o borracheiro digita). NULL = NÃO preenchido = a loja
--               fica FORA da entrega na proximidade-primeiro (silêncio ≠ consentimento —
--               ele dirige na entrega). A retirada dela continua normal (não usa raio).
--               NUMERIC(6,2): cobre de 0,01 a 9999,99 km com folga.
--
-- ─────────────────────────────────────────────
-- ROLLBACK (reverter o backend que lê esta coluna ANTES da migration):
--   ALTER TABLE network.partner_units
--     DROP COLUMN IF EXISTS delivery_radius_km;
-- ─────────────────────────────────────────────

ALTER TABLE network.partner_units
  ADD COLUMN IF NOT EXISTS delivery_radius_km NUMERIC(6,2);

COMMENT ON COLUMN network.partner_units.delivery_radius_km IS
  'Raio máximo de ENTREGA da loja em km (número livre digitado pelo dono no painel). NULL = não preenchido = FORA da entrega na proximidade-primeiro (a retirada continua, não usa raio). Lido só na Fase 3 (entrega por proximidade): a loja entra na entrega se delivery_radius_km IS NOT NULL E distância ≤ delivery_radius_km. Decisão Wallace 2026-06-09.';
