import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { getAdminContext, requireAdminAuth } from '../auth.js';
import { getCustomerDetail } from './customer-detail.js';

const paramsSchema = z.object({ source:z.enum(['chatwoot','balcao','parceiro','atacado']),id:z.string().uuid() });
const querySchema = z.object({ offset:z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit:z.coerce.number().int().min(1).max(30).optional() });

export async function registerCustomerDetailRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/clientes/:source/:id/ficha',{ preHandler:requireAdminAuth },async (request,reply) => {
    reply.header('Cache-Control','private, no-store');
    if (env.MATRIZ_CUSTOMER_IDENTITY && getAdminContext(request).role !== 'owner') {
      return reply.status(403).send({ error:'admin_owner_required' });
    }
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.status(400).send({ error:'invalid_request' });
    try {
      const result = await getCustomerDetail(env.FAREJADOR_ENV,params.data.source,params.data.id,query.data);
      return result ? reply.send(result) : reply.status(404).send({ error:'customer_not_found' });
    } catch {
      // A ficha contém dados pessoais; não ecoar SQL nem detalhes do cadastro em erros/logs.
      return reply.status(503).send({ error:'customer_detail_unavailable' });
    }
  });
}
