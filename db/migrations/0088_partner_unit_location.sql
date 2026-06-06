-- 0088: Localização da loja (link do Google Maps + lat/long) em network.partner_units.
--       Base da "Ideia 1" (o bot manda o GPS da loja quando o cliente manda a
--       localização ou escolhe retirada) e PREPARA a "Ideia 2" (distância) sem
--       precisar de outra migration depois.
--
-- 100% ADITIVA / RETROCOMPATÍVEL: só ADD COLUMN IF NOT EXISTS. ZERO DROP de dado.
-- NENHUMA coluna nova é lida pelo código de hoje — até o deploy da UI/bot, é
-- invisível e inofensiva (não muda nada do comportamento atual).
--
--   maps_url  = link do Google Maps que o DONO cola na tela "Dados da loja".
--               É esse link que o bot envia pro cliente. NULL = não configurado.
--   latitude / longitude = coordenadas exatas (NUMERIC, graus decimais). NULL por
--               ora; preparadas pro cálculo de distância da Rede (Ideia 2 / Fase 2).
--               Um link colado nem sempre dá lat/long limpa, então o preenchimento
--               das coordenadas fica para um fluxo futuro (ex.: pino no mapa).
--
-- ─────────────────────────────────────────────
-- ROLLBACK (reverter o backend que lê estas colunas ANTES da migration):
--   ALTER TABLE network.partner_units
--     DROP COLUMN IF EXISTS maps_url,
--     DROP COLUMN IF EXISTS latitude,
--     DROP COLUMN IF EXISTS longitude;
-- ─────────────────────────────────────────────

ALTER TABLE network.partner_units
  ADD COLUMN IF NOT EXISTS maps_url   TEXT,
  ADD COLUMN IF NOT EXISTS latitude   NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS longitude  NUMERIC(9,6);

COMMENT ON COLUMN network.partner_units.maps_url IS
  'Link do Google Maps da loja (colado pelo dono na tela Dados da loja). O bot envia este link ao cliente na retirada / quando o cliente manda a localização. NULL = não configurado. Ideia 1 (2026-06-06).';
COMMENT ON COLUMN network.partner_units.latitude IS
  'Latitude da loja (NUMERIC graus decimais). NULL por ora; preparada para cálculo de distância da Rede (Ideia 2 / Fase 2). Um link de Maps nem sempre dá lat/long limpa — preenchimento fica para fluxo futuro.';
COMMENT ON COLUMN network.partner_units.longitude IS
  'Longitude da loja (NUMERIC graus decimais). NULL por ora; par da latitude (Ideia 2 / Fase 2).';
