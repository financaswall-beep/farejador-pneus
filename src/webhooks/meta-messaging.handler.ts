import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../persistence/db.js';
import { insertRawMetaMessagingEvent } from '../persistence/meta-messaging-events.repository.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { validateMetaMessagingSignature, verifyTokenMatches } from './meta-messaging.hmac.js';

interface VerifyQuery {
  'hub.mode'?: unknown;
  'hub.verify_token'?: unknown;
  'hub.challenge'?: unknown;
}

export async function metaMessagingVerifyHandler(
  request: FastifyRequest<{ Querystring: VerifyQuery }>,
  reply: FastifyReply,
): Promise<void> {
  if (!env.META_MESSAGING_WEBHOOK_ENABLED) {
    return reply.status(404).send({ error: 'Not found' });
  }
  const mode = request.query['hub.mode'];
  const token = request.query['hub.verify_token'];
  const challenge = request.query['hub.challenge'];
  if (
    mode !== 'subscribe'
    || typeof token !== 'string'
    || typeof challenge !== 'string'
    || !env.META_MESSAGING_WEBHOOK_VERIFY_TOKEN
    || !verifyTokenMatches(token, env.META_MESSAGING_WEBHOOK_VERIFY_TOKEN)
  ) {
    return reply.status(403).send({ error: 'Verification failed' });
  }
  return reply.status(200).type('text/plain').send(challenge);
}

export async function metaMessagingWebhookHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!env.META_MESSAGING_WEBHOOK_ENABLED) {
    return reply.status(404).send({ error: 'Not found' });
  }
  const rawBody = (request.raw as typeof request.raw & { rawBody?: unknown }).rawBody;
  const signature = request.headers['x-hub-signature-256'];
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !env.META_APP_SECRET) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }
  if (!validateMetaMessagingSignature(rawBody, signature, env.META_APP_SECRET)) {
    logger.warn({ environment: env.FAREJADOR_ENV }, 'Meta messaging webhook signature rejected');
    return reply.status(401).send({ error: 'Invalid signature' });
  }
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply.status(400).send({ error: 'Invalid payload' });
  }
  const objectType = (body as Record<string, unknown>).object;
  if (typeof objectType !== 'string' || objectType.length === 0) {
    return reply.status(400).send({ error: 'Invalid payload' });
  }

  const client = await pool.connect().catch(() => null);
  if (!client) return reply.status(500).send({ error: 'Internal server error' });
  try {
    await client.query('BEGIN');
    const rawEventId = await insertRawMetaMessagingEvent(client, {
      rawBody,
      signature,
      objectType,
      payload: body,
    });
    if (rawEventId != null) {
      await client.query("SELECT pg_notify('meta_messaging_events_new','')");
    }
    await client.query('COMMIT');
    return reply.status(200).send({ received: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error({ err: error }, 'failed to persist Meta messaging webhook');
    return reply.status(500).send({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}
