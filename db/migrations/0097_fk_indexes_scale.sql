-- ============================================================
-- 0097 — Índices de FK para escala (auditoria 360° de 2026-06-12)
-- ------------------------------------------------------------
-- 24 FKs sem índice de coluna-líder (levantadas por consulta ao
-- catálogo + advisor). Em especial os unit_id das partner_*:
-- TODA query do painel filtra por unit_id (e a RLS injeta o
-- filtro em cada SELECT) — sem índice vira seq scan com volume.
-- Tabelas pequenas hoje: criação instantânea, custo zero.
-- ============================================================

CREATE INDEX IF NOT EXISTS conversation_facts_superseded_by_idx ON analytics.conversation_facts (superseded_by);

CREATE INDEX IF NOT EXISTS fitment_discoveries_evidence_conversation_id_idx ON commerce.fitment_discoveries (evidence_conversation_id);
CREATE INDEX IF NOT EXISTS fitment_discoveries_promoted_to_fitment_id_idx ON commerce.fitment_discoveries (promoted_to_fitment_id);
CREATE INDEX IF NOT EXISTS fitment_discoveries_tire_spec_id_idx ON commerce.fitment_discoveries (tire_spec_id);
CREATE INDEX IF NOT EXISTS orders_geo_resolution_id_idx ON commerce.orders (geo_resolution_id);
CREATE INDEX IF NOT EXISTS tire_specs_product_id_idx ON commerce.tire_specs (product_id);

-- Silo do parceiro: unit_id é o filtro de TODA leitura (painel + RLS)
CREATE INDEX IF NOT EXISTS partner_conversations_unit_id_idx ON commerce.partner_conversations (unit_id);
CREATE INDEX IF NOT EXISTS partner_customers_unit_id_idx ON commerce.partner_customers (unit_id);
CREATE INDEX IF NOT EXISTS partner_messages_unit_id_idx ON commerce.partner_messages (unit_id);
CREATE INDEX IF NOT EXISTS partner_orders_customer_id_idx ON commerce.partner_orders (customer_id);
CREATE INDEX IF NOT EXISTS partner_purchase_items_product_id_idx ON commerce.partner_purchase_items (product_id);
CREATE INDEX IF NOT EXISTS partner_purchase_items_purchase_id_idx ON commerce.partner_purchase_items (purchase_id);
CREATE INDEX IF NOT EXISTS partner_purchases_unit_id_idx ON commerce.partner_purchases (unit_id);
CREATE INDEX IF NOT EXISTS partner_stock_levels_product_id_idx ON commerce.partner_stock_levels (product_id);
CREATE INDEX IF NOT EXISTS partner_stock_levels_unit_id_idx ON commerce.partner_stock_levels (unit_id);
CREATE INDEX IF NOT EXISTS photo_request_blobs_unit_id_idx ON commerce.photo_request_blobs (unit_id);
CREATE INDEX IF NOT EXISTS photo_requests_unit_id_idx ON commerce.photo_requests (unit_id);

CREATE INDEX IF NOT EXISTS partner_expenses_unit_id_idx ON finance.partner_expenses (unit_id);
CREATE INDEX IF NOT EXISTS partner_payables_unit_id_idx ON finance.partner_payables (unit_id);
CREATE INDEX IF NOT EXISTS partner_receivables_customer_id_idx ON finance.partner_receivables (customer_id);
CREATE INDEX IF NOT EXISTS partner_receivables_unit_id_idx ON finance.partner_receivables (unit_id);

CREATE INDEX IF NOT EXISTS network_partner_units_unit_id_idx ON network.partner_units (unit_id);
CREATE INDEX IF NOT EXISTS unit_coverage_unit_id_idx ON network.unit_coverage (unit_id);

CREATE INDEX IF NOT EXISTS agent_incidents_agent_turn_id_idx ON ops.agent_incidents (agent_turn_id);
