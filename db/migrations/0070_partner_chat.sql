-- ============================================================
-- 0070_partner_chat.sql
-- Chat unificado no Portal Parceiro — Fatia 1 (fundacao de dados).
--
-- Contexto (Wallace, 2026-05-29):
--   O cliente fala pelo WhatsApp/Instagram/Facebook; o Chatwoot unifica os
--   canais (motor de mensageria). Queremos que o parceiro converse com o
--   cliente DENTRO do portal (aba Bate-papo F7), sem abrir o Chatwoot.
--   Decisao de arquitetura: Opcao B (UI custom + sync via API), NAO embed.
--   Plano completo: docs/PLANO_CHAT_UNIFICADO_PARCEIRO_2026-05-29.md
--
-- Principio: tudo passa pelo banco nas duas direcoes. O banco e a fonte de
--   verdade; o Chatwoot e o carteiro. Entrada (webhook) grava aqui; saida
--   (portal) grava aqui antes de mandar pro Chatwoot.
--
-- O que esta migration faz (Fatia 1 — so dados):
--   1. commerce.partner_conversations — uma linha por conversa do Chatwoot,
--      atribuida a uma unidade parceira (unit_id = core.units.id).
--   2. commerce.partner_messages — mensagens (inbound/outbound), com dedup do
--      ECO do Chatwoot via UNIQUE(environment, chatwoot_message_id).
--
-- Convencoes seguidas (padrao de 0060_partner_customers.sql):
--   - coluna environment env_t NOT NULL; unit_id -> core.units(id)
--   - RLS por unidade via network.current_partner_core_unit()
--   - triggers network.set_updated_at() e ops.validate_env_match(...)
--   - escrita pelo pool do bot/admin (BYPASSRLS); leitura pelo pool do portal
--     (role farejador_partner_app, RLS efetiva)
--
-- Aditiva: nao altera nenhuma tabela/dado existente. Reversivel via DROP.
--
-- Decisao de escopo (Fatia 1): o portal so LE conversas e LE/INSERE mensagens
--   (envio de saida). "Marcar como lida" (zerar unread_count) fica visual no
--   front por enquanto; persistencia entra na Fatia 2 via function controlada.
--   O backfill de chatwoot_message_id em mensagens outbound (casar o eco) e
--   feito pelo lado do bot (pool BYPASSRLS), nao pelo portal — por isso o
--   portal NAO ganha UPDATE.
--
-- Assinatura: Claude (Opus 4.8), 2026-05-29
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. CONVERSAS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.partner_conversations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment              env_t NOT NULL,
  unit_id                  UUID NOT NULL REFERENCES core.units(id),
  chatwoot_conversation_id BIGINT NOT NULL,
  channel                  TEXT NOT NULL DEFAULT 'whatsapp'
                             CHECK (channel IN ('whatsapp', 'instagram', 'facebook', 'other')),
  customer_name            TEXT,
  customer_identifier      TEXT,             -- telefone E.164 ou @handle
  customer_location        TEXT,             -- bairro/CEP captado pelo bot (slot)
  initial_intent           TEXT,             -- "queria pneu 90/90-18" (slot)
  status                   TEXT NOT NULL DEFAULT 'open'
                             CHECK (status IN ('bot', 'open', 'in_progress', 'resolved', 'transferred')),
  last_message_at          TIMESTAMPTZ,
  unread_count             INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ
);

-- Uma conversa do Chatwoot = uma linha (upsert pelo webhook). Idempotencia.
CREATE UNIQUE INDEX IF NOT EXISTS partner_conversations_cw_uniq
  ON commerce.partner_conversations(environment, chatwoot_conversation_id);

-- Lista do portal: conversas da unidade, mais recentes primeiro.
CREATE INDEX IF NOT EXISTS partner_conversations_unit_idx
  ON commerce.partner_conversations(environment, unit_id, last_message_at DESC);

-- ─────────────────────────────────────────────
-- 2. MENSAGENS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commerce.partner_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment         env_t NOT NULL,
  unit_id             UUID NOT NULL REFERENCES core.units(id),
  conversation_id     UUID NOT NULL REFERENCES commerce.partner_conversations(id),
  chatwoot_message_id BIGINT,               -- nulo so na janela otimista do envio
  direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender              TEXT NOT NULL CHECK (sender IN ('customer', 'bot', 'partner')),
  content             TEXT,
  attachments         JSONB NOT NULL DEFAULT '[]'::jsonb,
  client_token        TEXT,                 -- gerado pelo portal pra casar o eco
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup do ECO: a mesma mensagem do Chatwoot nunca entra duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS partner_messages_cw_uniq
  ON commerce.partner_messages(environment, chatwoot_message_id)
  WHERE chatwoot_message_id IS NOT NULL;

-- Thread: mensagens da conversa em ordem cronologica.
CREATE INDEX IF NOT EXISTS partner_messages_conv_idx
  ON commerce.partner_messages(conversation_id, created_at);

-- Backfill do eco em outbound: casar pelo client_token na janela otimista.
CREATE INDEX IF NOT EXISTS partner_messages_client_token_idx
  ON commerce.partner_messages(environment, client_token)
  WHERE client_token IS NOT NULL;

-- ─────────────────────────────────────────────
-- 3. TRIGGERS (updated_at + invariante de ambiente)
-- ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS partner_conversations_set_updated_at ON commerce.partner_conversations;
CREATE TRIGGER partner_conversations_set_updated_at
  BEFORE UPDATE ON commerce.partner_conversations
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS env_match_partner_conversations_unit ON commerce.partner_conversations;
CREATE TRIGGER env_match_partner_conversations_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON commerce.partner_conversations
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

DROP TRIGGER IF EXISTS env_match_partner_messages_unit ON commerce.partner_messages;
CREATE TRIGGER env_match_partner_messages_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON commerce.partner_messages
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

-- ─────────────────────────────────────────────
-- 4. RLS — isolamento por unidade parceira
-- ─────────────────────────────────────────────
ALTER TABLE commerce.partner_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_conversations_isolation ON commerce.partner_conversations;
CREATE POLICY partner_conversations_isolation ON commerce.partner_conversations
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  );

ALTER TABLE commerce.partner_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_messages_isolation ON commerce.partner_messages;
CREATE POLICY partner_messages_isolation ON commerce.partner_messages
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND unit_id = network.current_partner_core_unit()
  );

-- ─────────────────────────────────────────────
-- 5. GRANTS — portal le conversa, le/insere mensagem (envio de saida)
-- ─────────────────────────────────────────────
GRANT SELECT         ON commerce.partner_conversations TO farejador_partner_app;
GRANT SELECT, INSERT ON commerce.partner_messages      TO farejador_partner_app;

-- ─────────────────────────────────────────────
-- 6. COMENTARIOS
-- ─────────────────────────────────────────────
COMMENT ON TABLE commerce.partner_conversations IS
  'Conversas do Chatwoot espelhadas no banco, atribuidas a uma unidade parceira. '
  'Fonte de verdade local do chat do portal (0070). Upsert pelo webhook por '
  '(environment, chatwoot_conversation_id).';
COMMENT ON TABLE commerce.partner_messages IS
  'Mensagens do chat do parceiro (inbound/outbound). Dedup do eco do Chatwoot via '
  'UNIQUE(environment, chatwoot_message_id). client_token casa a mensagem otimista '
  'de saida com o eco do webhook (0070).';
COMMENT ON COLUMN commerce.partner_messages.client_token IS
  'Token gerado pelo portal no envio. Permite casar a mensagem otimista (inserida '
  'pelo portal) com o eco que volta do Chatwoot, evitando duplicata.';
