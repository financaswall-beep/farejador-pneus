import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { dashboardPayload } from './route-helpers.js';
import { getClientesPainel } from './queries-clientes.js';

export async function registerPainelClientes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/clientes', { preHandler: requireAdminAuth }, async (_request, reply) => {
    const data = await getClientesPainel();
    return reply.status(200).send({ ...dashboardPayload(data.rows), partners: data.partners });
  });
}
