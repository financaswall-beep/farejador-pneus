import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';
import { getTireLotPurchase, listLotSeparationSources, listTireLotMovements, listTireLots } from './queries-tire-lots.js';
import { lotSeparationSchema, separateTireLot } from './tire-lot-separation.js';

export async function registerTireLotRoutes(app: FastifyInstance) {
  const page = z.coerce.number().int().min(1).max(100000).default(1);
  const search = z.string().trim().max(100).default('');
  app.get('/admin/api/wholesale/lots/:id/purchase', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_query' });
    const purchase = await getTireLotPurchase(params.data.id);
    return purchase ?? reply.status(404).send({ error: 'purchase_not_found' });
  });
  app.get('/admin/api/wholesale/lots', { preHandler: requireAdminAuth }, async (request, reply) => {
    const query = z.object({ page, search, status: z.enum(['all','open','pending','closed','cancelled']).default('open') }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_query' });
    return listTireLots(query.data);
  });
  app.get('/admin/api/wholesale/lot-movements', { preHandler: requireAdminAuth }, async (request, reply) => {
    const query = z.object({ page, lot_id: z.string().uuid().optional() }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_query' });
    return listTireLotMovements(query.data);
  });
  app.get('/admin/api/wholesale/lot-separation-sources', { preHandler: requireAdminOwner }, async (request, reply) => {
    const query = z.object({ search }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_query' });
    return listLotSeparationSources(query.data.search);
  });
  app.post('/admin/api/wholesale/lot-separations', { preHandler: requireAdminOwner }, async (request, reply) => {
    const body = lotSeparationSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'invalid_body' });
    try { return reply.status(201).send(await separateTireLot(body.data, operatorLabel(request))); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (['lot_source_not_found','lot_source_insufficient','lot_source_cost_missing'].includes(code)) {
        return reply.status(409).send({ error: code });
      }
      const mapped = mapWriteError(error);
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });
}
