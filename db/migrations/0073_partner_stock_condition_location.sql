-- 0073: Condição e Localização no estoque do parceiro
--
-- Campos pedidos pelo cadastro do painel parceiro (tela de Estoque refit 2W):
--   - tire_condition: condição do item (Novo | Usado | Recapado), texto livre.
--   - shelf_location: localização física na loja (ex.: A-01-02), texto livre.
--
-- Aditivo e seguro: colunas nuláveis, sem default, sem reescrita de linha,
-- sem impacto em dados existentes. Idempotente (IF NOT EXISTS).

ALTER TABLE commerce.partner_stock_levels
  ADD COLUMN IF NOT EXISTS tire_condition text,
  ADD COLUMN IF NOT EXISTS shelf_location text;

COMMENT ON COLUMN commerce.partner_stock_levels.tire_condition IS
  'Condição do item: Novo | Usado | Recapado (NULL = não informado).';
COMMENT ON COLUMN commerce.partner_stock_levels.shelf_location IS
  'Localização física na loja (ex.: A-01-02). Texto livre.';
