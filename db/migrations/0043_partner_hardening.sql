-- ============================================================
-- 0043_partner_hardening.sql
-- Reconstrucao em arquivo da migration aplicada via MCP Supabase em 2026-05-20.
--
-- Objetivo (segunda rodada de hardening do silo do parceiro):
--   - Trigger automatico de updated_at em partner_orders (faltava).
--   - FKs sensiveis com ON DELETE SET NULL: hard-delete upstream preserva
--     historico do parceiro.
--   - UNIQUE natural-key em estoque do parceiro: previne race em auto-create
--     de estoque via compra concorrente.
--   - env_match em partner_orders + partner_order_items: consistencia com
--     o resto do silo.
--   - Comentarios nas colunas status/deleted_at de partner_orders esclarecendo
--     que cancelamento usa status, nao deleted_at.
--
-- Escopo:
--   Zero efeito em bot/atendente/planner/organizadora.
--
-- Idempotente: usa IF NOT EXISTS / DROP TRIGGER IF EXISTS / DROP CONSTRAINT
-- IF EXISTS pra poder rodar varias vezes sem erro.
--
-- Reconstruido a partir do estado real do banco prod (pg_constraint,
-- pg_trigger, pg_indexes) em 2026-05-21.
-- Assinatura: Claude (Opus 4.7), 2026-05-21
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. Trigger set_updated_at em partner_orders
-- ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS partner_orders_set_updated_at ON commerce.partner_orders;
CREATE TRIGGER partner_orders_set_updated_at
  BEFORE UPDATE ON commerce.partner_orders
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

-- ─────────────────────────────────────────────
-- 2. env_match em partner_orders e partner_order_items
--    (faltavam — outras tabelas ja tinham desde 0035)
-- ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS env_match_partner_orders_unit ON commerce.partner_orders;
CREATE TRIGGER env_match_partner_orders_unit
  BEFORE INSERT OR UPDATE OF unit_id ON commerce.partner_orders
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

DROP TRIGGER IF EXISTS env_match_partner_order_items_order ON commerce.partner_order_items;
CREATE TRIGGER env_match_partner_order_items_order
  BEFORE INSERT OR UPDATE OF order_id ON commerce.partner_order_items
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('commerce', 'partner_orders', 'order_id');

-- ─────────────────────────────────────────────
-- 3. FKs com ON DELETE SET NULL
--    - partner_order_items.partner_stock_id → preserva venda historica
--      mesmo se hard-delete do item de estoque (snapshot do nome/size/brand
--      fica na linha)
--    - partner_purchase_items.product_id → matriz deletar produto nao
--      trava compras antigas
--    - partner_stock_levels.product_id → idem
-- ─────────────────────────────────────────────

-- partner_order_items.partner_stock_id
ALTER TABLE commerce.partner_order_items
  DROP CONSTRAINT IF EXISTS partner_order_items_partner_stock_id_fkey;
ALTER TABLE commerce.partner_order_items
  ADD CONSTRAINT partner_order_items_partner_stock_id_fkey
  FOREIGN KEY (partner_stock_id)
  REFERENCES commerce.partner_stock_levels(id)
  ON DELETE SET NULL;

-- partner_purchase_items.product_id
ALTER TABLE commerce.partner_purchase_items
  DROP CONSTRAINT IF EXISTS partner_purchase_items_product_id_fkey;
ALTER TABLE commerce.partner_purchase_items
  ADD CONSTRAINT partner_purchase_items_product_id_fkey
  FOREIGN KEY (product_id)
  REFERENCES commerce.products(id)
  ON DELETE SET NULL;

-- partner_stock_levels.product_id
ALTER TABLE commerce.partner_stock_levels
  DROP CONSTRAINT IF EXISTS partner_stock_levels_product_id_fkey;
ALTER TABLE commerce.partner_stock_levels
  ADD CONSTRAINT partner_stock_levels_product_id_fkey
  FOREIGN KEY (product_id)
  REFERENCES commerce.products(id)
  ON DELETE SET NULL;

-- ─────────────────────────────────────────────
-- 4. UNIQUE natural-key em partner_stock_levels
--    Previne race em auto-create de estoque por compras concorrentes:
--    sem isso, 2 compras simultaneas do mesmo pneu podiam gerar 2 linhas
--    duplicadas no estoque do parceiro.
--    Match consistente com a busca em registerPartnerPurchase
--    (queries.ts:557-560: lower(trim()) em item_name + tire_size + brand
--    + supplier_name).
-- ─────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS partner_stock_natural_key_uniq
  ON commerce.partner_stock_levels (
    environment,
    unit_id,
    lower(trim(item_name)),
    COALESCE(lower(trim(tire_size)), ''),
    COALESCE(lower(trim(brand)), ''),
    COALESCE(lower(trim(supplier_name)), '')
  )
  WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────
-- 5. Comentarios esclarecendo convencao status vs deleted_at em partner_orders
-- ─────────────────────────────────────────────
COMMENT ON COLUMN commerce.partner_orders.status IS
  'Cancelamento normal: ''cancelled''. Para excluir definitivamente (LGPD), usar deleted_at = now() em vez de mudar status.';

COMMENT ON COLUMN commerce.partner_orders.deleted_at IS
  'Soft-delete reservado pra exclusao definitiva (LGPD, erro grave). Cancelamento normal usa status=''cancelled'' SEM mexer em deleted_at. Hoje a aplicacao nao escreve nessa coluna — mantida pra uso futuro.';
