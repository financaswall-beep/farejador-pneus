-- 0122: índice pra busca de pedidos por ROTA (P2 da banca 07-03, revisão "a rota
-- se pagou?"). A 0121 criou commerce.orders.trip_id mas nenhum índice com ele de
-- líder — o tripSelect de getMatrizLogistica (deliveries_count + resumo financeiro
-- da rota) filtra WHERE o.trip_id = t.id por rota exibida (2 SELECTs × até 11
-- rotas por GET): sem índice é seq scan na tabela que MAIS cresce do projeto.
-- Parcial (trip_id IS NOT NULL): pedido fora de rota (a imensa maioria) não paga o custo.
--
-- Rollback: DROP INDEX IF EXISTS commerce.orders_trip_idx;

CREATE INDEX IF NOT EXISTS orders_trip_idx
  ON commerce.orders (environment, trip_id)
  WHERE trip_id IS NOT NULL;
