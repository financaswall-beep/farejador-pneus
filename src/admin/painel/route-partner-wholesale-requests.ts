import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { operatorLabel } from './route-helpers.js';
import { decideWholesaleRequest, listWholesaleRequests } from './queries-partner-wholesale-requests.js';
import { buyRequestError } from '../../parceiro/route-buy-request-errors.js';

export function registerWholesaleRequestRoutes(fastify: FastifyInstance) {
  fastify.get('/admin/api/wholesale/partner-requests',{preHandler:requireAdminAuth}, async (_request,reply) => {
    reply.header('Cache-Control','no-store');
    try { return await listWholesaleRequests(env.FAREJADOR_ENV); }
    catch (error) { const mapped=buyRequestError(error); return reply.code(mapped.status).send({error:mapped.error}); }
  });
  const params=z.object({id:z.string().uuid(),action:z.enum(['approve','reject','dispatch'])});
  const body=z.object({reason:z.string().trim().min(3).max(500).optional(),
    due_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).strict();
  fastify.post('/admin/api/wholesale/partner-requests/:id/:action',{preHandler:requireAdminOwner},async (request,reply) => {
    const p=params.safeParse(request.params),b=body.safeParse(request.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({error:'invalid_body'});
    try { return await decideWholesaleRequest({...p.data,...b.data,environment:env.FAREJADOR_ENV,actor:operatorLabel(request)}); }
    catch (error) { const mapped=buyRequestError(error); return reply.code(mapped.status).send({error:mapped.error}); }
  });
}
