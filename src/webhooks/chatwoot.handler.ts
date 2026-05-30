import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { claimAndInsertRawEvent } from '../persistence/raw-events.repository.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { chatwootWebhookEnvelopeSchema, chatwootWebhookHeadersSchema } from '../shared/types/chatwoot.js';
import { parseChatwootTimestamp, validateHmac, validateTimestamp } from './chatwoot.hmac.js';

export async function chatwootWebhookHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawBody = (request.raw as typeof request.raw & { rawBody?: unknown }).rawBody;
  if (!Buffer.isBuffer(rawBody)) {
    return reply.status(400).send({ error: 'Invalid request body' });
  }

  const parsedBody = request.body;

  const headersResult = chatwootWebhookHeadersSchema.safeParse(request.headers);
  if (!headersResult.success) {
    return reply.status(401).send({ error: 'Missing required headers' });
  }

  const headers = headersResult.data;
  const chatwootDeliveryId = headers['x-chatwoot-delivery'];
  const chatwootSignature = headers['x-chatwoot-signature'];
  const chatwootTimestamp = headers['x-chatwoot-timestamp'];

  const logCtx = {
    chatwoot_delivery_id: chatwootDeliveryId,
    environment: env.FAREJADOR_ENV,
  };

  if (!chatwootTimestamp || !validateTimestamp(chatwootTimestamp)) {
    logger.warn(logCtx, 'webhook timestamp missing or expired');
    return reply.status(401).send({ error: 'Timestamp missing or expired' });
  }

  const parsedTimestamp = parseChatwootTimestamp(chatwootTimestamp);
  if (!parsedTimestamp) {
    logger.warn(logCtx, 'webhook timestamp invalid');
    return reply.status(401).send({ error: 'Timestamp invalid' });
  }

  if (!validateHmac(rawBody, chatwootSignature, chatwootTimestamp)) {
    logger.warn(logCtx, 'webhook HMAC validation failed');
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  const envelopeResult = chatwootWebhookEnvelopeSchema.safeParse(parsedBody);
  if (!envelopeResult.success) {
    logger.warn({ ...logCtx, reason: 'schema validation failed' }, 'webhook payload invalid');
    return reply.status(400).send({ error: 'Invalid payload' });
  }

  const envelope = envelopeResult.data;
  const eventType = envelope.event;
  const accountId = envelope.account?.id ?? null;
  const handlerLogCtx = {
    ...logCtx,
    event_type: eventType,
  };

  let client: PoolClient | null = null;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const rawEventId = await claimAndInsertRawEvent(client, {
      chatwootDeliveryId,
      chatwootSignature,
      chatwootTimestamp: parsedTimestamp,
      eventType,
      accountId,
      payload: parsedBody,
    });

    if (!rawEventId) {
      await client.query('ROLLBACK');
      logger.warn(handlerLogCtx, 'duplicate delivery skipped');
      return reply.status(200).send({ received: true, delivery_id: chatwootDeliveryId });
    }

    // Tempo real: acorda o worker de normalizacao na hora. pg_notify dentro da
    // transacao dispara no COMMIT. Aqui rawEventId sempre e novo (duplicata ja
    // retornou acima), entao avisamos sem condicao extra. O worker tem o poll de
    // 5s como rede de seguranca caso o aviso se perca.
    await client.query("SELECT pg_notify('raw_events_new', '')");

    await client.query('COMMIT');

    logger.info(handlerLogCtx, 'webhook received and persisted');
    return reply.status(200).send({ received: true, delivery_id: chatwootDeliveryId });
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    logger.error({ err, ...handlerLogCtx }, 'failed to persist webhook');
    return reply.status(500).send({ error: 'Internal server error' });
  } finally {
    client?.release();
  }
}
