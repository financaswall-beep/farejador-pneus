import type { FastifyInstance } from 'fastify';
import { getPartnerContext, requirePartnerAuth, requireScreen, type PartnerAuthedRequest } from './auth.js';
import { getPartnerBuyCatalog } from './operation-buy-catalog.js';

export function registerPartnerBuyCatalogRoutes(fastify: FastifyInstance) {
  fastify.get('/parceiro/:slug/api/operacao/comprar', {
    preHandler: [requirePartnerAuth, requireScreen('estoque')],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    return getPartnerBuyCatalog(getPartnerContext(request));
  });
}
