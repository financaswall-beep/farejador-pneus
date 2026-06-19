-- 0109b_push_pk_include_unit.sql
-- Corrige a PK de commerce.partner_push_subscriptions pra incluir unit_id.
-- Motivo (porta única, 0095): o dono loga em N lojas no MESMO celular → o mesmo
-- endpoint de push precisa se inscrever em várias unidades. PK só por endpoint
-- caía numa linha de OUTRA unidade no ON CONFLICT (invisível pro pool restrito da
-- RLS) e travava a inscrição. Tabela recém-criada e vazia → troca de PK segura.
--
-- Instalação NOVA: o 0109 já nasce com a PK certa (environment, unit_id, endpoint);
-- aqui o DROP/ADD vira idempotente (re-cria a mesma PK).

ALTER TABLE commerce.partner_push_subscriptions
  DROP CONSTRAINT partner_push_subscriptions_pkey;
ALTER TABLE commerce.partner_push_subscriptions
  ADD CONSTRAINT partner_push_subscriptions_pkey PRIMARY KEY (environment, unit_id, endpoint);
