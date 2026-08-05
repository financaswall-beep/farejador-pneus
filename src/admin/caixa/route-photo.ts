import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dispatchPhotoToCustomer } from '../../atendente-v2/photo-requests.js';
import { subscribePartnerChat, type PartnerChatEvent } from '../../normalization/partner-chat.notify.js';
import { env } from '../../shared/config/env.js';
import { rateLimitHit } from '../../shared/rate-limit.js';
import { acquirePartnerSseSlot } from '../../parceiro/sse-limit.js';
import {
  PHOTO_MAX_UPLOAD_BYTES,
  PhotoRejectedError,
  reencodePhoto,
} from '../../parceiro/photo-upload.js';
import type { CaixaAuth } from './queries.js';
import { attachCaixaPhoto, getCaixaMainUnitId, getCaixaPhotoQueue } from './photo.js';
import { consumeCaixaSseTicket, mintCaixaSseTicket } from './sse-ticket.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type CaixaRequest = FastifyRequest & { caixa?: CaixaAuth };
const photoParamsSchema = z.object({ photoRequestId: z.string().uuid() });

export function registerCaixaPhotoRoutes(
  fastify: FastifyInstance,
  flagGate: PreHandler,
  requireCaixaAuth: PreHandler,
): void {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp'] as const) {
    if (!fastify.hasContentTypeParser(mime)) {
      fastify.addContentTypeParser(mime, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    }
  }

  fastify.get('/api/caixa/photo-requests', {
    preHandler: [flagGate, requireCaixaAuth],
  }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!env.PHOTO_REQUESTS) return reply.status(200).send({ enabled: false, photo_requests: [] });
    return reply.status(200).send({
      enabled: true,
      photo_requests: await getCaixaPhotoQueue(env.FAREJADOR_ENV),
    });
  });

  fastify.post('/api/caixa/photo-requests/:photoRequestId/photo', {
    preHandler: [flagGate, requireCaixaAuth],
    bodyLimit: PHOTO_MAX_UPLOAD_BYTES,
  }, async (request: CaixaRequest, reply) => {
    if (!env.PHOTO_REQUESTS) return reply.status(404).send({ error: 'feature_off' });
    const params = photoParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'photo_request_not_found' });
    const auth = request.caixa!;
    if (rateLimitHit(`caixa-photo:${auth.personId}:${request.ip}`, 15, 5 * 60 * 1000)) {
      return reply.status(429).send({ error: 'rate_limited' });
    }
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      return reply.status(415).send({ error: 'not_an_image' });
    }
    let photo;
    try {
      photo = await reencodePhoto(request.body);
    } catch (error) {
      if (error instanceof PhotoRejectedError) return reply.status(415).send({ error: error.reason });
      throw error;
    }
    const result = await attachCaixaPhoto(env.FAREJADOR_ENV, params.data.photoRequestId, {
      bytes: photo.bytes,
      mime: photo.mime,
      sizeBytes: photo.bytes.length,
    });
    if (result.status === 'not_found') return reply.status(404).send({ error: 'photo_request_not_found' });
    if (result.status === 'rejected') return reply.status(415).send({ error: 'not_an_image' });
    if (result.attached) {
      void dispatchPhotoToCustomer(
        params.data.photoRequestId,
        { bytes: photo.bytes, mime: photo.mime },
        result.was_late === true,
      ).catch((error) => request.log.error({ err: error }, 'caixa photo dispatch falhou'));
    }
    return reply.status(200).send({ ok: true, state: result.state, attached: result.attached });
  });

  fastify.post('/api/caixa/photo-stream-ticket', {
    preHandler: [flagGate, requireCaixaAuth],
  }, async (request: CaixaRequest, reply) => {
    if (!env.PHOTO_REQUESTS) return reply.status(404).send({ error: 'feature_off' });
    const auth = request.caixa!;
    if (rateLimitHit(`caixa-sse-ticket:${auth.personId}`, 30, 60_000)) {
      return reply.status(429).send({ error: 'too_many_attempts' });
    }
    const unitId = await getCaixaMainUnitId(env.FAREJADOR_ENV);
    if (!unitId) return reply.status(503).send({ error: 'main_unit_not_found' });
    const issued = mintCaixaSseTicket({ unitId, subject: `caixa:${auth.personId}` });
    return reply.status(201).send({ ticket: issued.ticket, expires_in: issued.expiresInSeconds });
  });

  fastify.get('/api/caixa/photo-stream', async (request, reply) => {
    if (!env.MATRIZ_CAIXA_PORTAL || !env.PHOTO_REQUESTS) return reply.status(404).send({ error: 'not_found' });
    const { ticket } = request.query as { ticket?: string };
    const ctx = ticket ? consumeCaixaSseTicket(ticket) : null;
    if (!ctx) return reply.status(401).send({ error: 'unauthorized' });
    const releaseSlot = acquirePartnerSseSlot(request.ip, ctx.subject);
    if (!releaseSlot) return reply.status(429).send({ error: 'too_many_connections' });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 3000\n\n: conectado\n\n');
    const unsubscribe = subscribePartnerChat(ctx.unitId, (event: PartnerChatEvent) => {
      raw.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => raw.write(': hb\n\n'), 25_000);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      releaseSlot();
    };
    raw.on('close', close);
    raw.on('error', close);
  });
}
