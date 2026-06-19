-- 0109_partner_push_subscriptions.sql
-- PUSH (PWA): notificação nativa do celular pro borracheiro quando cai FOTO ou
-- PEDIDO novo, mesmo com o navegador FECHADO. Cada aparelho que "permite avisos"
-- vira uma inscrição (endpoint + chaves p256dh/auth que o serviço de push do
-- navegador devolve). O disparador do servidor manda o push pra TODOS os endpoints
-- da unidade. Endpoint inválido (404/410) é apagado pelo próprio disparador.
--
-- Uma loja pode ter vários aparelhos (dono + funcionário, celular + tablet) → 1
-- linha por (loja, aparelho). PK (environment, unit_id, endpoint): re-permitir o
-- MESMO aparelho na MESMA loja só atualiza as chaves (ON CONFLICT), não duplica.
-- Por que unit_id no PK (e não só endpoint): com a porta única (0095), o dono loga
-- em várias lojas no MESMO celular → o mesmo endpoint pode se inscrever em N lojas
-- (ele quer o aviso de todas). Chavear só por endpoint quebraria isso na RLS (o
-- ON CONFLICT cairia numa linha de OUTRA unidade, invisível pro pool restrito).
--
-- RLS espelha as outras partner_* (partner_dismissed_items_isolation): só a própria
-- unidade, via app.partner_unit_id → network.current_partner_core_unit(). O pool
-- restrito (farejador_partner_app) ganha SELECT/INSERT/DELETE; nada de UPDATE
-- (a contagem de falha/sucesso é escrita pelo disparador, que roda no pool do bot).

CREATE TABLE IF NOT EXISTS commerce.partner_push_subscriptions (
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  environment     text        NOT NULL,
  unit_id         uuid        NOT NULL,
  endpoint        text        NOT NULL,
  p256dh          text        NOT NULL,
  auth            text        NOT NULL,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failure_count   int         NOT NULL DEFAULT 0,
  PRIMARY KEY (environment, unit_id, endpoint)
);

-- Lookup do disparador: todas as inscrições de uma unidade.
CREATE INDEX IF NOT EXISTS partner_push_subscriptions_unit_idx
  ON commerce.partner_push_subscriptions (environment, unit_id);

ALTER TABLE commerce.partner_push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_push_subscriptions_isolation ON commerce.partner_push_subscriptions;
CREATE POLICY partner_push_subscriptions_isolation ON commerce.partner_push_subscriptions
  FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL
         AND unit_id = network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL
              AND unit_id = network.current_partner_core_unit());

GRANT SELECT, INSERT, DELETE ON commerce.partner_push_subscriptions TO farejador_partner_app;
