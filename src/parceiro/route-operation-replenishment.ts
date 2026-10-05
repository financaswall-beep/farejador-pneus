import type { FastifyInstance } from 'fastify';
import { getPartnerContext, requirePartnerAuth, requireScreen, type PartnerAuthedRequest } from './auth.js';
import { getPartnerReplenishment } from './operation-replenishment.js';

export function registerPartnerReplenishmentRoutes(fastify: FastifyInstance) {
  fastify.get('/parceiro/:slug/api/operacao/reposicao', {
    preHandler: [requirePartnerAuth, requireScreen('estoque')],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    return getPartnerReplenishment(getPartnerContext(request));
  });
}
