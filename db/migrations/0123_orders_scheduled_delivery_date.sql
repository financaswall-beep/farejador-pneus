-- 0123: data REMARCADA de entrega (agendamento da logística da matriz — 07-03e,
-- pedido do dono). Regra de negócio (palavra do dono): toda entrega "nasce" pra o
-- DIA SEGUINTE do pedido (D+1), automático — pedi hoje, sai amanhã. Por isso a data
-- PADRÃO é DERIVADA de created_at na LEITURA (COALESCE(scheduled_delivery_date,
-- created_at+1, fuso SP)), e o bot NÃO é tocado (a data sempre nasce sozinha).
-- Esta coluna guarda só a EXCEÇÃO: quando o dono REMARCA (ex.: não entregou no dia
-- → empurra pra outro). NULL = usa o padrão D+1.
--
-- Nullable SEM default de propósito: ADD COLUMN nullable não reescreve a tabela
-- (commerce.orders é a que MAIS cresce) — zero lock em produção viva. Um default
-- volátil (now()+1) forçaria REWRITE da tabela inteira; por isso o D+1 vive na
-- LEITURA, não aqui.
--
-- Rollback: ALTER TABLE commerce.orders DROP COLUMN scheduled_delivery_date;

ALTER TABLE commerce.orders ADD COLUMN IF NOT EXISTS scheduled_delivery_date DATE;

COMMENT ON COLUMN commerce.orders.scheduled_delivery_date IS
  'Data REMARCADA da entrega (logística da matriz). NULL = usa o padrão D+1 (created_at+1, fuso America/Sao_Paulo), calculado na leitura. Só a matriz lê.';
