-- 0117 — Fatia 2 do financeiro da matriz: custo do GALPÃO congelado na venda do VAREJO.
-- O atacado já congela (wholesale_order_items.unit_cost, 0112); o varejo da matriz não —
-- se o custo médio mudar amanhã, o lucro de ontem vira chute. Esta coluna é o retrato.
--
-- Aditiva e NULA: commerce.order_items não tem grant pra nenhum role de app além do
-- sistema (conferido 2026-07-02 em information_schema.role_table_grants) → o custo da
-- matriz NÃO vaza pro parceiro. NULL = sem custo congelado (venda de parceiro, venda
-- antiga, flag WHOLESALE_MATRIZ_RETAIL_COST off, ou medida sem custo no galpão) — o
-- resumo do varejo conta essas linhas à parte em vez de inventar custo.
ALTER TABLE commerce.order_items
  ADD COLUMN IF NOT EXISTS matriz_unit_cost numeric;

COMMENT ON COLUMN commerce.order_items.matriz_unit_cost IS
  'Custo médio do galpão (commerce.wholesale_stock.unit_cost) congelado no momento da venda do VAREJO da matriz (0117). NULL = não congelado (parceiro/antigo/flag off/sem custo no galpão).';
