import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dispatchPhotoToCustomer } from '../atendente-v2/photo-requests.js';
import { rateLimitHit } from '../shared/rate-limit.js';
import { env } from '../shared/config/env.js';
import {
  getPartnerContext, requirePartnerAuth, requireScreen, resolvePartnerPermissions,
  type PartnerAuthedRequest,
} from './auth.js';
import { getPartnerOperationNotifications } from './operation-notifications.js';
import { PHOTO_MAX_UPLOAD_BYTES, PhotoRejectedError, reencodePhoto } from './photo-upload.js';
import { attachPartnerPhoto, getPartnerPhotoQueue } from './queries.js';

const photoParams = z.object({ photoRequestId: z.string().uuid() });

export function registerPartnerOperationNotificationRoutes(fastify: FastifyInstance): void {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp'] as const) {
    if (!fastify.hasContentTypeParser(mime)) {
      fastify.addContentTypeParser(mime, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    }
  }

  fastify.get('/parceiro/:slug/api/operacao/pedidos-foto', {
    preHandler: [requirePartnerAuth, requireScreen('vendas')],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!env.PHOTO_REQUESTS) return reply.status(200).send({ enabled: false, photo_requests: [] });
    return reply.status(200).send({
      enabled: true,
      photo_requests: await getPartnerPhotoQueue(getPartnerContext(request)),
    });
  });

  fastify.post('/parceiro/:slug/api/operacao/pedidos-foto/:photoRequestId/foto', {
    preHandler: [requirePartnerAuth, requireScreen('vendas')],
    bodyLimit: PHOTO_MAX_UPLOAD_BYTES,
  }, async (request: PartnerAuthedRequest, reply) => {
    if (!env.PHOTO_REQUESTS) return reply.status(404).send({ error: 'feature_off' });
    const parsed = photoParams.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'photo_request_not_found' });
    const ctx = getPartnerContext(request);
    if (rateLimitHit(`operation-photo:${ctx.tokenId}:${request.ip}`, 15, 5 * 60_000)) {
      return reply.status(429).send({ error: 'rate_limited' });
    }
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      return reply.status(415).send({ error: 'not_an_image' });
    }
    try {
      const photo = await reencodePhoto(request.body);
      const result = await attachPartnerPhoto(ctx, parsed.data.photoRequestId, {
        bytes: photo.bytes, mime: photo.mime, sizeBytes: photo.bytes.length,
      });
      if (result.status === 'not_found') return reply.status(404).send({ error: 'photo_request_not_found' });
      if (result.status === 'rejected') return reply.status(415).send({ error: 'not_an_image' });
      if (result.attached) {
        void dispatchPhotoToCustomer(
          parsed.data.photoRequestId,
          { bytes: photo.bytes, mime: photo.mime },
          result.was_late === true,
        ).catch((error) => request.log.error({ err: error }, 'operation partner photo dispatch falhou'));
      }
      return reply.status(200).send({ ok: true, state: result.state, attached: result.attached });
    } catch (error) {
      if (error instanceof PhotoRejectedError) return reply.status(415).send({ error: error.reason });
      throw error;
    }
  });

  fastify.get('/parceiro/:slug/api/operacao/notificacoes', {
    preHandler: [requirePartnerAuth],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ctx = getPartnerContext(request);
    const permissions = await resolvePartnerPermissions(ctx);
    return reply.status(200).send(await getPartnerOperationNotifications(ctx, permissions));
  });
}
