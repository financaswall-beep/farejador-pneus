import type { FastifyInstance } from 'fastify';
import {
  metaMessagingVerifyHandler,
  metaMessagingWebhookHandler,
} from './meta-messaging.handler.js';

export async function registerMetaMessagingWebhookRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get('/webhooks/meta/messaging', metaMessagingVerifyHandler);
  fastify.post('/webhooks/meta/messaging', metaMessagingWebhookHandler);
}
