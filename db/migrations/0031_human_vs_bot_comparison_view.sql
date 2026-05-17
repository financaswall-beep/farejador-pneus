-- ============================================================
-- 0031_human_vs_bot_comparison_view.sql
-- Fase D estendida: compara resposta humana real vs resposta shadow da Atendente.
--
-- Leitura apenas:
-- - nao altera dados operacionais;
-- - nao envia mensagem ao cliente;
-- - junta core.messages (humano/cliente) com agent.turns (shadow).
-- ============================================================

CREATE OR REPLACE VIEW ops.human_vs_bot_comparison AS
WITH customer_messages AS (
  SELECT
    conv.environment,
    conv.id AS conversation_id,
    conv.chatwoot_conversation_id,
    conv.chatwoot_inbox_id,
    conv.channel_type,
    conv.contact_id,
    contact.name AS contact_name,
    msg.id AS customer_message_id,
    msg.chatwoot_message_id AS customer_chatwoot_message_id,
    msg.content AS customer_text,
    msg.sent_at AS customer_sent_at,
    lead(msg.sent_at) OVER (
      PARTITION BY msg.environment, msg.conversation_id
      ORDER BY msg.sent_at ASC, msg.chatwoot_message_id ASC
    ) AS next_customer_sent_at
  FROM core.messages msg
  JOIN core.conversations conv
    ON conv.environment = msg.environment
   AND conv.id = msg.conversation_id
  LEFT JOIN core.contacts contact
    ON contact.environment = conv.environment
   AND contact.id = conv.contact_id
  WHERE msg.sender_type = 'contact'
    AND msg.message_type_name = 'incoming'
    AND msg.is_private = false
    AND msg.deleted_at IS NULL
    AND conv.deleted_at IS NULL
)
SELECT
  cm.environment,
  cm.conversation_id,
  cm.chatwoot_conversation_id,
  cm.chatwoot_inbox_id,
  cm.channel_type,
  cm.contact_id,
  cm.contact_name,

  cm.customer_message_id,
  cm.customer_chatwoot_message_id,
  cm.customer_text,
  cm.customer_sent_at,

  human_reply.human_message_id,
  human_reply.human_chatwoot_message_id,
  human_reply.human_text,
  human_reply.human_sent_at,
  human_reply.human_sender_id,

  bot_turn.agent_turn_id,
  bot_turn.agent_version,
  bot_turn.selected_skill,
  bot_turn.bot_status,
  bot_turn.bot_text,
  bot_turn.bot_error_message,
  bot_turn.bot_actions,
  bot_turn.bot_blocked_payload,
  bot_turn.bot_generated_at,
  bot_turn.llm_input_tokens,
  bot_turn.llm_output_tokens,
  bot_turn.llm_duration_ms,

  CASE
    WHEN human_reply.human_message_id IS NULL THEN 'missing_human_reply'
    WHEN bot_turn.agent_turn_id IS NULL THEN 'missing_bot_shadow'
    WHEN bot_turn.bot_status = 'blocked' THEN 'bot_blocked'
    WHEN bot_turn.bot_text IS NULL OR btrim(bot_turn.bot_text) = '' THEN 'bot_empty'
    ELSE 'paired'
  END AS comparison_status,

  EXTRACT(EPOCH FROM (human_reply.human_sent_at - cm.customer_sent_at))::INTEGER
    AS human_reply_seconds,
  EXTRACT(EPOCH FROM (bot_turn.bot_generated_at - cm.customer_sent_at))::INTEGER
    AS bot_shadow_seconds
FROM customer_messages cm
LEFT JOIN LATERAL (
  SELECT
    reply.id AS human_message_id,
    reply.chatwoot_message_id AS human_chatwoot_message_id,
    reply.content AS human_text,
    reply.sent_at AS human_sent_at,
    reply.sender_id AS human_sender_id
  FROM core.messages reply
  WHERE reply.environment = cm.environment
    AND reply.conversation_id = cm.conversation_id
    AND reply.sender_type = 'user'
    AND reply.message_type_name = 'outgoing'
    AND reply.is_private = false
    AND reply.deleted_at IS NULL
    AND reply.sent_at > cm.customer_sent_at
    AND (
      cm.next_customer_sent_at IS NULL
      OR reply.sent_at < cm.next_customer_sent_at
    )
  ORDER BY reply.sent_at ASC, reply.chatwoot_message_id ASC
  LIMIT 1
) human_reply ON true
LEFT JOIN LATERAL (
  SELECT
    turn.id AS agent_turn_id,
    turn.agent_version,
    turn.selected_skill,
    turn.status AS bot_status,
    CASE
      WHEN turn.status = 'blocked' THEN turn.blocked_say_text
      ELSE turn.say_text
    END AS bot_text,
    turn.error_message AS bot_error_message,
    CASE
      WHEN turn.status = 'blocked' THEN turn.blocked_actions
      ELSE turn.actions
    END AS bot_actions,
    turn.blocked_payload AS bot_blocked_payload,
    turn.created_at AS bot_generated_at,
    turn.llm_input_tokens,
    turn.llm_output_tokens,
    turn.llm_duration_ms
  FROM agent.turns turn
  WHERE turn.environment = cm.environment
    AND turn.conversation_id = cm.conversation_id
    AND turn.trigger_message_id = cm.customer_message_id
  ORDER BY turn.created_at DESC
  LIMIT 1
) bot_turn ON true;

COMMENT ON VIEW ops.human_vs_bot_comparison IS
  'Fase D: pareia cada mensagem publica do cliente com a primeira resposta humana publica antes da proxima mensagem do cliente e com a resposta shadow da Atendente ligada por trigger_message_id.';

COMMENT ON COLUMN ops.human_vs_bot_comparison.customer_text IS
  'Mensagem real do cliente que disparou o turno.';

COMMENT ON COLUMN ops.human_vs_bot_comparison.human_text IS
  'Primeira resposta humana publica no Chatwoot depois da mensagem do cliente e antes da proxima mensagem do cliente.';

COMMENT ON COLUMN ops.human_vs_bot_comparison.bot_text IS
  'Resposta que a Atendente teria enviado em shadow; usa blocked_say_text quando o turno foi bloqueado.';

COMMENT ON COLUMN ops.human_vs_bot_comparison.comparison_status IS
  'paired, bot_blocked, bot_empty, missing_human_reply ou missing_bot_shadow.';
