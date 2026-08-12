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

export function registerPartnerOperationDeliveryRoutes(fastify: FastifyInstance): void {
  const deliveriesScreen = [requirePartnerAuth, requireScreen('entregas')];

  fastify.get('/parceiro/:slug/api/operacao/entregas', {
    preHandler: deliveriesScreen,
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send(
      await getPartnerOperationDeliveries(getPartnerContext(request)),
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
