import type { PoolClient } from 'pg';
import type { MappedMessage } from './message.mapper.js';
import type { UpsertedMessage } from '../persistence/messages.repository.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { lockBotConversation, syncHumanIntervention } from '../atendente-v2/conversation-control.js';
import { isAgentV2ConversationAllowed } from '../atendente-v2/conversation-scope.js';
import { enqueueAtendenteJob, ensureAtendenteSession } from '../shared/repositories/ops-atendente.repository.js';

/** Determinístico e privado. Falha operacional não invalida raw/core; o sender
 * verifica novamente o banco e não envia enquanto o controle estiver indisponível. */
export async function handleBotMessageEvent(client: PoolClient, eventType: string,
  message: MappedMessage, upserted: UpsertedMessage, rawEventId: number): Promise<void> {
  if (eventType==='message_created') {
    const reason = !env.AGENT_V2_WORKER_ENABLED ? 'because AGENT_V2_WORKER_ENABLED=false'
      : message.senderType!=='contact' ? '— sender_type is not contact'
        : !isAgentV2ConversationAllowed(env.AGENT_V2_CONVERSATION_IDS,upserted.conversationId)
          ? '— conversation outside configured scope' : null;
    if (reason) logger.info({ raw_event_id:rawEventId,conversation_id:upserted.conversationId,
      message_id:upserted.messageId,...(message.senderType!=='contact' ? { sender_type:message.senderType } : {}) },
    `normalization: atendente job skipped ${reason}`);
  }
  const humanCandidate = message.senderType==='user' && message.messageType===1 && !message.isPrivate;
  const customerTrigger = eventType==='message_created' && message.senderType==='contact'
    && !message.isPrivate && env.AGENT_V2_WORKER_ENABLED
    && isAgentV2ConversationAllowed(env.AGENT_V2_CONVERSATION_IDS,upserted.conversationId);
  if (!humanCandidate && !customerTrigger) return;
  const environment = message.environment as Environment;
  await client.query('SAVEPOINT bot_message_control');
  try {
    await lockBotConversation(client,environment,upserted.conversationId);
    const state = await syncHumanIntervention(client,environment,upserted.conversationId);
    if (customerTrigger && state.mode==='auto'
      && (!state.resumed_at || message.sentAt>new Date(state.resumed_at))) {
      const sessionId = await ensureAtendenteSession(client,environment,upserted.conversationId,upserted.messageId);
      const jobId = await enqueueAtendenteJob(client,environment,upserted.conversationId,upserted.messageId,
        env.AGENT_V2_DEBOUNCE_SECONDS);
      logger.info({ raw_event_id:rawEventId,conversation_id:upserted.conversationId,message_id:upserted.messageId,
        agent_session_id:sessionId,atendente_job_id:jobId },'normalization: atendente job enqueued');
    }
    await client.query('RELEASE SAVEPOINT bot_message_control');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT bot_message_control');
    await client.query('RELEASE SAVEPOINT bot_message_control');
    logger.error({ err:error,conversation_id:upserted.conversationId },
      'bot control unavailable: ingestion preserved; outbound guard will fail closed');
  }
}
