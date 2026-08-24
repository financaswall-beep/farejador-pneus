import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPartnerContext,
  requirePartnerAuth,
  requireScreen,
  type PartnerAuthedRequest,
} from './auth.js';
import {
  getPartnerOperationDeliveries,
  getPartnerOperationDeliveryPhoto,
} from './operation-deliveries.js';

const photoParamsSchema = z.object({ photoRequestId: z.string().uuid() });
const feedQuerySchema = z.object({
  view: z.enum(['active', 'history']).default('active'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export function registerPartnerOperationDeliveryRoutes(fastify: FastifyInstance): void {
  const deliveriesScreen = [requirePartnerAuth, requireScreen('entregas')];

  fastify.get('/parceiro/:slug/api/operacao/entregas', {
    preHandler: deliveriesScreen,
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = feedQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(
      await getPartnerOperationDeliveries(getPartnerContext(request), parsed.data),
    );
  });

  fastify.get('/parceiro/:slug/api/operacao/entregas/fotos/:photoRequestId', {
    preHandler: deliveriesScreen,
  }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = photoParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'photo_not_found' });
    const photo = await getPartnerOperationDeliveryPhoto(
      getPartnerContext(request),
      parsed.data.photoRequestId,
    );
    if (!photo) return reply.status(404).send({ error: 'photo_not_found' });
    return reply
      .header('Content-Type', photo.mime)
      .header('Cache-Control', 'private, max-age=300')
      .status(200)
      .send(photo.bytes);
  });
}
