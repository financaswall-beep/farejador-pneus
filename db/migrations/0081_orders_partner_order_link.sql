-- 0081_orders_partner_order_link.sql
-- ETAPA 3 (Tijolo 3.2) da Fundação Bot → Rede.
--
-- Liga commerce.orders (o ESPELHO que o bot grava pra TODA venda, exigido pelo
-- analytics) ao commerce.partner_orders (o DONO operacional: estoque/COD/recebível)
-- quando a venda do bot é roteada a um parceiro.
--
-- LEI da fundação: cada número tem UM dono. Esta coluna é só o PONTEIRO do espelho
-- pro dono — não duplica nada. Serve pra:
--   - propagar cancelamento/edição (espelho segue o dono — plano §4.3/4.4);
--   - achar o espelho a partir do partner_order e vice-versa.
--
-- ADITIVA E REVERSÍVEL: coluna nullable, SEM backfill, SEM DROP. Vendas da matriz
-- continuam com partner_order_id = NULL (= comportamento de hoje). Nenhum consumidor
-- de commerce.orders exige esta coluna — analytics / painel / customer_profile /
-- network_orders_unified seguem intactos.
--
-- ON DELETE SET NULL (não CASCADE): partner_orders são cancelados por status, nunca
-- deletados de verdade; mas SE algum dia um for deletado, o espelho do analytics NÃO
-- pode sumir junto (corromperia faturamento/conversão) — só perde o ponteiro.

ALTER TABLE commerce.orders
  ADD COLUMN IF NOT EXISTS partner_order_id UUID NULL
  REFERENCES commerce.partner_orders(id) ON DELETE SET NULL;

COMMENT ON COLUMN commerce.orders.partner_order_id IS
  'Venda do bot roteada a parceiro: aponta pro commerce.partner_orders dono (estoque/COD/recebivel). NULL = venda da matriz. Fundacao Bot->Rede, Tijolo 3.2 (migration 0081).';

-- Índice parcial: indexa só as linhas roteadas a parceiro (a maioria é matriz/NULL).
-- Usado pra localizar o espelho a partir do partner_order (propagação de cancel/edição).
CREATE INDEX IF NOT EXISTS orders_partner_order_id_idx
  ON commerce.orders (partner_order_id)
  WHERE partner_order_id IS NOT NULL;
