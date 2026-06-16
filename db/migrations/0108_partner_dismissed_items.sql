-- 0108_partner_dismissed_items.sql
-- "Arquivar / tirar da tela" (decisão do dono 2026-06-16): o borracheiro tira
-- QUALQUER item da tela de trabalho sem perder o dado — o registro fica no banco
-- e aparece no Relatório. Tabela GENÉRICA (1 migration serve pra tudo: pedido,
-- conta, despesa, compra, foto…) — ZERO toque nas tabelas de negócio.
--
-- 🔒 Arquivar é SÓ visual: o filtro desta tabela entra apenas nas queries de
-- LISTA de exibição; NUNCA nos totais (caixa/a receber/comissão) nem no Relatório.
--
-- RLS espelha as outras partner_* (partner_conversations_isolation): só a própria
-- unidade, via app.partner_unit_id → network.current_partner_core_unit(). O pool
-- restrito (farejador_partner_app) ganha SELECT/INSERT/DELETE; nada de UPDATE.

CREATE TABLE IF NOT EXISTS commerce.partner_dismissed_items (
  environment  text        NOT NULL,
  unit_id      uuid        NOT NULL,
  item_type    text        NOT NULL,   -- order | payable | receivable | expense | purchase | photo
  item_id      text        NOT NULL,   -- text = genérico (uuid de qualquer tabela)
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  dismissed_by text,                    -- 'owner:<slug>' / 'func:<tokenId>' (rastro, sem PII)
  PRIMARY KEY (environment, unit_id, item_type, item_id)
);

-- Lookup do NOT EXISTS das listas (por unidade + tipo).
CREATE INDEX IF NOT EXISTS partner_dismissed_items_lookup_idx
  ON commerce.partner_dismissed_items (environment, unit_id, item_type);

ALTER TABLE commerce.partner_dismissed_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_dismissed_items_isolation ON commerce.partner_dismissed_items;
CREATE POLICY partner_dismissed_items_isolation ON commerce.partner_dismissed_items
  FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL
         AND unit_id = network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL
              AND unit_id = network.current_partner_core_unit());

GRANT SELECT, INSERT, DELETE ON commerce.partner_dismissed_items TO farejador_partner_app;
