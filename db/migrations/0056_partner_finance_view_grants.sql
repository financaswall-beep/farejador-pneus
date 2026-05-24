-- ============================================================
-- 0056_partner_finance_view_grants.sql
-- Corrige grants das views recriadas nas migrations 0053/0055.
--
-- Contexto:
--   network.partner_unit_summary e network.partner_cash_flow_projection
--   foram recriadas com DROP/CREATE ou CREATE OR REPLACE durante a
--   reconciliacao financeira. A role do portal parceiro precisa de SELECT
--   nessas views para carregar /api/resumo e /api/fluxo-caixa.
--
-- Idempotente: GRANT pode ser reaplicado sem efeito colateral.
-- ============================================================

GRANT SELECT ON network.partner_unit_summary TO farejador_partner_app;
GRANT SELECT ON network.partner_cash_flow_projection TO farejador_partner_app;

