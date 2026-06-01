-- ============================================================
-- 0079_partner_conversation_customer_link.sql
-- Vínculo DURÁVEL conversa → cliente do chat unificado.
--
-- Problema: getPartnerChatCustomer casa o cliente por TELEFONE
-- (normalizeBrazilianPhone(customer_identifier)). Conversa de
-- Instagram/Facebook NÃO tem telefone no identificador (é um ID da
-- rede), então o vínculo "esquecia" ao recarregar — só funcionava no
-- WhatsApp. Esta coluna grava o cliente direto na conversa, então o
-- vínculo persiste em qualquer canal.
--
-- Aditivo e idempotente: coluna nullable + FK ON DELETE SET NULL
-- (excluir o cliente desvincula a conversa, não apaga a conversa) +
-- índice parcial. A role do parceiro já tem SELECT na tabela, o que
-- cobre a coluna nova (mesma situação do 0072).
-- ============================================================

ALTER TABLE commerce.partner_conversations
  ADD COLUMN IF NOT EXISTS customer_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_conversations_customer_fk'
  ) THEN
    ALTER TABLE commerce.partner_conversations
      ADD CONSTRAINT partner_conversations_customer_fk
      FOREIGN KEY (customer_id)
      REFERENCES commerce.partner_customers (id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS partner_conversations_customer_idx
  ON commerce.partner_conversations (customer_id)
  WHERE customer_id IS NOT NULL;

COMMENT ON COLUMN commerce.partner_conversations.customer_id IS
  'Cliente vinculado à conversa (qualquer canal). Preenchido ao cadastrar/vincular pelo chat. Tem prioridade sobre o match por telefone em getPartnerChatCustomer.';
