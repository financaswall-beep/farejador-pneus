import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPartnerContext, requirePartnerAuth, requireScreen, type PartnerAuthedRequest } from './auth.js';
import { getPartnerPickupPhoto } from './operation-pickup-photo.js';
import { markPartnerPickupRetrieved, PickupAlreadyRetrievedError } from './pickup-queries.js';

const paramsSchema = z.object({ orderId: z.string().uuid() });
const photoParamsSchema = paramsSchema.extend({ itemId: z.string().uuid() });

export function registerPartnerOperationPickupRoutes(fastify: FastifyInstance): void {
  const guarded = [requirePartnerAuth, requireScreen('retiradas')];
  fastify.get('/parceiro/:slug/api/operacao/retiradas/:orderId/itens/:itemId/foto', {
    preHandler: guarded,
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const params = photoParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'photo_not_found' });
    const photo = await getPartnerPickupPhoto(getPartnerContext(request), params.data.orderId, params.data.itemId);
    if (!photo) return reply.status(404).send({ error: 'photo_not_found' });
    return reply.header('Content-Type', photo.mime).header('X-Content-Type-Options', 'nosniff').send(photo.bytes);
  });
  fastify.post('/parceiro/:slug/api/operacao/retiradas/:orderId/confirmar', {
    preHandler: guarded,
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'pickup_not_found' });
    // O cliente não fornece preço, pagamento ou serviços neste fluxo simplificado.
    if (!z.object({}).strict().safeParse(request.body ?? {}).success) {
      return reply.status(400).send({ error: 'invalid_body' });
    }
    try {
      return await markPartnerPickupRetrieved(getPartnerContext(request), params.data.orderId, {});
    } catch (error) {
      if (error instanceof PickupAlreadyRetrievedError) return reply.status(409).send({ error: error.code });
      if (error instanceof Error && error.message === 'pickup_not_found') return reply.status(404).send({ error: error.message });
      if (error instanceof Error && error.message.includes('Reserva insuficiente')) {
        return reply.status(409).send({ error: 'reserva_insuficiente' });
      }
      throw error;
    }
  });
}
