-- ============================================================
-- 0072_partner_chat_avatar.sql
-- Foto do contato (avatar) na conversa do chat unificado.
-- Aditivo e idempotente: só adiciona uma coluna nullable.
-- Origem: payload do Chatwoot em conversation.meta.sender.thumbnail.
-- ============================================================

ALTER TABLE commerce.partner_conversations
  ADD COLUMN IF NOT EXISTS customer_avatar_url TEXT;
