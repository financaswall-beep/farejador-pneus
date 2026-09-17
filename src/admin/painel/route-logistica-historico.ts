import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logisticsHistoryQuery, listMatrizHistory, listClosedTripDeliveries } from './queries-logistica-historico.js';
export async function registerLogisticsHistoryRoutes(app: FastifyInstance) {
  app.get('/admin/api/logistica/historico', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.code(404).send({ error: 'logistics_disabled' });
    const parsed = logisticsHistoryQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_filters' });
    return reply.header('Cache-Control', 'no-store').send(await listMatrizHistory(parsed.data));
  });
  app.get('/admin/api/logistica/historico/:tripId/entregas', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.code(404).send({ error: 'logistics_disabled' });
    const parsed = z.object({ tripId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_trip' });
    return reply.header('Cache-Control', 'no-store').send(await listClosedTripDeliveries(parsed.data.tripId));
  });
}
