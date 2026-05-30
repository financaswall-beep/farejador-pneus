import type { PoolClient } from 'pg';
import type { ChatwootEventType } from '../shared/types/chatwoot.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { mapContact } from './contact.mapper.js';
import { mapConversation } from './conversation.mapper.js';
import { mapMessage } from './message.mapper.js';
import { mapAttachment } from './attachment.mapper.js';
import { mapStatusEvent } from './status-event.mapper.js';
import { mapAssignment } from './assignment.mapper.js';
import { mapReaction } from './reaction.mapper.js';
import { mapTags } from './tag.mapper.js';
import { upsertContact } from '../persistence/contacts.repository.js';
import { upsertConversation } from '../persistence/conversations.repository.js';
import { upsertMessage } from '../persistence/messages.repository.js';
import { fanOutMessageToPartnerChat } from './partner-chat.fanout.js';
import { upsertAttachment } from '../persistence/attachments.repository.js';
import { insertStatusEvent } from '../persistence/status-events.repository.js';
import { insertAssignment } from '../persistence/assignments.repository.js';
import { insertReaction } from '../persistence/reactions.repository.js';
import { upsertTags } from '../persistence/tags.repository.js';
import {
  enqueueAtendenteJob,
  ensureAtendenteSession,
} from '../shared/repositories/ops-atendente.repository.js';
import type { Environment } from '../shared/types/chatwoot.js';

export interface RawEvent {
  id: number;
  event_type: string;
  payload: unknown;
  environment: string;
  chatwoot_timestamp: Date | null;
}

export class SkipEventError extends Error {
  constructor(eventType: string) {
    super(`Event type skipped: ${eventType}`);
    this.name = 'SkipEventError';
  }
}

function readObject(source: unknown, key: string): Record<string, unknown> | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function findNestedContactPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const topLevelSender = readObject(payload, 'sender');
  const topLevelMeta = readObject(payload, 'meta');
  const topLevelMetaSender = readObject(topLevelMeta, 'sender');
  const conversation = readObject(payload, 'conversation');
  const conversationMeta = readObject(conversation, 'meta');
  const conversationSender = readObject(conversationMeta, 'sender');
  const candidate = topLevelMetaSender ?? conversationSender ?? topLevelSender;

  if (!candidate || typeof candidate.id !== 'number') {
    return null;
  }

  return {
    id: candidate.id,
    name: typeof candidate.name === 'string' ? candidate.name : null,
    email: typeof candidate.email === 'string' ? candidate.email : null,
    phone_number: typeof candidate.phone_number === 'string' ? candidate.phone_number : null,
    identifier: typeof candidate.identifier === 'string' ? candidate.identifier : null,
    additional_attributes: readObject(candidate, 'additional_attributes') ?? {},
    custom_attributes: readObject(candidate, 'custom_attributes') ?? {},
  };
}

async function upsertNestedContactIfPresent(
  client: PoolClient,
  payload: Record<string, unknown>,
  environment: string,
  lastEventAt: Date,
): Promise<void> {
  const contactPayload = findNestedContactPayload(payload);
  if (!contactPayload) {
    return;
  }

  const contact = mapContact(contactPayload, environment, lastEventAt);
  await upsertContact(client, contact);
}

export async function dispatch(
  client: PoolClient,
  rawEvent: RawEvent,
): Promise<void> {
  const eventType = rawEvent.event_type as ChatwootEventType;
  const payload = rawEvent.payload as Record<string, unknown>;
  const environment = rawEvent.environment;
  const lastEventAt = rawEvent.chatwoot_timestamp ?? new Date();
  const rawEventId = rawEvent.id;

  if (env.SKIP_EVENT_TYPES.includes(eventType)) {
    logger.info(
      { event_type: eventType, raw_event_id: rawEventId },
      'event type configured to skip - marking as skipped',
    );
    throw new SkipEventError(eventType);
  }

  switch (eventType) {
    case 'contact_created':
    case 'contact_updated': {
      const contact = mapContact(payload, environment, lastEventAt);
      await upsertContact(client, contact);
      break;
    }

    case 'conversation_created':
    case 'conversation_updated': {
      await upsertNestedContactIfPresent(client, payload, environment, lastEventAt);

      const conversation = mapConversation(payload, environment, lastEventAt);
      const conversationId = await upsertConversation(client, conversation);

      if (payload.labels && Array.isArray(payload.labels)) {
        const tags = mapTags(
          payload as { id: number; labels?: string[] },
          environment,
          lastEventAt,
        );
        await upsertTags(client, tags, conversationId);
      }

      if (eventType === 'conversation_updated' && payload.changed_attributes) {
        const changedAttrs = payload.changed_attributes as Array<{
          attribute: string;
          previous_value?: string;
          current_value?: string;
        }>;

        const statusChange = changedAttrs.find((a) => a.attribute === 'status');
        if (statusChange) {
          const statusEvent = mapStatusEvent(
            payload as { id: number; status?: string; updated_at?: unknown },
            environment,
            lastEventAt,
            rawEventId,
            statusChange.previous_value ?? null,
          );
          await insertStatusEvent(client, statusEvent, conversationId);
        }

        const assigneeChange = changedAttrs.find(
          (a) => a.attribute === 'assignee_id',
        );
        if (assigneeChange && payload.assignee_id != null) {
          const assignment = mapAssignment(
            payload as {
              id: number;
              assignee_id?: number | null;
              team_id?: number | null;
              updated_at?: unknown;
            },
            environment,
            lastEventAt,
          );
          if (assignment) {
            await insertAssignment(client, assignment, conversationId);
          }
        }
      }

      break;
    }

    case 'conversation_status_changed': {
      const conversation = mapConversation(payload, environment, lastEventAt);
      const conversationId = await upsertConversation(client, conversation);

      const changedAttrs = payload.changed_attributes as
        | Array<{
            attribute: string;
            previous_value?: string;
            current_value?: string;
          }>
        | undefined;
      const statusChange = changedAttrs?.find((a) => a.attribute === 'status');

      const statusEvent = mapStatusEvent(
        payload as { id: number; status?: string; updated_at?: unknown },
        environment,
        lastEventAt,
        rawEventId,
        statusChange?.previous_value ?? null,
      );
      await insertStatusEvent(client, statusEvent, conversationId);
      break;
    }

    case 'message_created':
    case 'message_updated': {
      await upsertNestedContactIfPresent(client, payload, environment, lastEventAt);

      const message = mapMessage(payload, environment, lastEventAt);
      const upsertedMessage = await upsertMessage(client, message);

      // Fan-out pro chat do Portal Parceiro (Fatia 1). Defensivo: nunca lança,
      // isola falha por SAVEPOINT próprio. Atrás da flag PARTNER_CHAT_FANOUT_ENABLED.
      if (eventType === 'message_created') {
        await fanOutMessageToPartnerChat(client, message, payload);
      }

      // Enfileira job do Agent V2 para a conversa.
      // So para message_created; message_updated nao dispara processamento.
      if (eventType === 'message_created') {
        if (env.AGENT_V2_WORKER_ENABLED) {
          // Só processa mensagens do contato (cliente real).
          // Mensagens de bot, agente humano e sistema não disparam o Atendente
          // para evitar que o bot responda a si mesmo quando o envio Chatwoot for habilitado.
          if (message.senderType !== 'contact') {
            logger.info(
              {
                raw_event_id: rawEventId,
                conversation_id: upsertedMessage.conversationId,
                message_id: upsertedMessage.messageId,
                sender_type: message.senderType,
              },
              'normalization: atendente job skipped — sender_type is not contact',
            );
          } else {
            const sessionId = await ensureAtendenteSession(
              client,
              environment as Environment,
              upsertedMessage.conversationId,
              upsertedMessage.messageId,
            );
            const jobId = await enqueueAtendenteJob(
              client,
              environment as Environment,
              upsertedMessage.conversationId,
              upsertedMessage.messageId,
              env.AGENT_V2_DEBOUNCE_SECONDS,
            );
            logger.info(
              {
                raw_event_id: rawEventId,
                conversation_id: upsertedMessage.conversationId,
                message_id: upsertedMessage.messageId,
                agent_session_id: sessionId,
                atendente_job_id: jobId,
              },
              'normalization: atendente job enqueued',
            );
          }
        } else {
          logger.info(
            {
              raw_event_id: rawEventId,
              conversation_id: upsertedMessage.conversationId,
              message_id: upsertedMessage.messageId,
            },
            'normalization: atendente job skipped because AGENT_V2_WORKER_ENABLED=false',
          );
        }
      }

      const attachments = (payload.attachments ?? []) as Array<
        Record<string, unknown>
      >;
      for (const attPayload of attachments) {
        const attachment = mapAttachment(attPayload, environment);
        await upsertAttachment(
          client,
          attachment,
          upsertedMessage.messageId,
          upsertedMessage.conversationId,
        );
      }

      const reactions = (payload.reactions ?? []) as Array<
        Record<string, unknown>
      >;
      for (const reactionPayload of reactions) {
        const reaction = mapReaction(reactionPayload, environment, lastEventAt);
        if (reaction) {
          await insertReaction(client, reaction, upsertedMessage.messageId);
        } else {
          logger.warn(
            { raw_event_id: rawEventId, event_type: eventType },
            'reaction payload received but mapper is placeholder',
          );
        }
      }

      break;
    }

    default: {
      logger.warn(
        { event_type: eventType, raw_event_id: rawEventId },
        'unknown event type - marking as skipped',
      );
      throw new SkipEventError(eventType);
    }
  }
}
