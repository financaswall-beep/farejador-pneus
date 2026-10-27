import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CaixaAuth } from './queries.js';
import { registerMarketingPublisher } from '../painel/route-marketing-publisher.js';
import { registerMarketingOrganicResults } from '../painel/route-marketing-organic-results.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export async function registerCaixaMarketingRoutes(app: FastifyInstance, flag: Gate, auth: Gate) {
  const owner: Gate = async (request, reply) => {
    if ((request as FastifyRequest & { caixa?: CaixaAuth }).caixa?.panelRole !== 'owner') {
      await reply.code(403).send({ error: 'owner_required' });
    }
  };
  const preHandler = [flag, auth, owner];
  await registerMarketingPublisher(app, { base: '/api/caixa/marketing/publisher', preHandler,
    actor: request => {
      const actor = (request as FastifyRequest & { caixa: CaixaAuth }).caixa;
      return { displayName: actor.displayName, personId: actor.personId };
    } });
  await registerMarketingOrganicResults(app, { base: '/api/caixa/marketing/organic/results', preHandler });
}
