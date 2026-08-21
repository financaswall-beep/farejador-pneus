import type { FastifyInstance } from 'fastify';
import { NETWORK_MUNICIPALITIES } from './municipality-catalog.js';

/** Catálogo público, sem dados pessoais, usado pelos seletores da matriz e parceiros. */
export async function registerMunicipalityCatalogRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/network/municipalities', async (_request, reply) => reply.send({
    state: 'RJ',
    municipalities: NETWORK_MUNICIPALITIES,
  }));
}
