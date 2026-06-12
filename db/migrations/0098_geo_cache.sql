-- ============================================================
-- 0098 — Cache de geocodificação/distância (auditoria 360° 2026-06-12)
-- ------------------------------------------------------------
-- Geocode de bairro/endereço e distância cliente→loja repetem MUITO
-- entre conversas, e o Google cobra por chamada (Geocoding e Distance
-- Matrix por elemento). Este cache corta o custo que cresce linear com
-- o volume e tira latência da resposta do bot.
--
-- Desenho:
--  - cache_key normalizada (texto minúsculo p/ geocode; coordenada
--    arredondada a 4 casas ≈ 11 m p/ reverse/distância);
--  - value jsonb = a resposta que o Google deu (o cache NUNCA inventa);
--  - SEM coluna environment: coordenada é fato físico, prod/test compartilham;
--  - SEM GRANT: só o pool admin (bot) usa; o portal do parceiro não toca;
--  - TTL na leitura (90d, no código) + faxina semanal pg_cron (>120d).
-- Código: src/shared/geo/geo-cache.ts (read-through, FAIL-OPEN — erro de
-- banco → chama o Google direto; flag GEO_CACHE=false desliga).
-- ============================================================

CREATE TABLE IF NOT EXISTS commerce.geo_cache (
  cache_key  text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('geocode', 'reverse', 'distance')),
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE commerce.geo_cache IS
  'Cache read-through do Google (Geocoding/Distance Matrix). Só resultado VÁLIDO entra (falha/ZERO_RESULTS não cacheia). TTL 90d na leitura (geo-cache.ts); faxina semanal pg_cron apaga >120d. Sem environment de propósito (coordenada é fato físico). 0098, auditoria 360° 2026-06-12.';

CREATE INDEX IF NOT EXISTS geo_cache_created_at_idx ON commerce.geo_cache (created_at);

SELECT cron.schedule(
  'farejador-geo-cache-sweep',
  '0 4 * * 1',
  $$ DELETE FROM commerce.geo_cache WHERE created_at < now() - interval '120 days' $$
);
