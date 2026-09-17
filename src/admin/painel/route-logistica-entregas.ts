import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { listMatrizDeliveries, logisticsDeliveriesQuery } from './queries-logistica-entregas.js';

export async function registerLogisticsDeliveriesRoutes(app: FastifyInstance) {
  app.get('/admin/api/logistica/entregas', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.code(404).send({ error: 'logistics_disabled' });
    const parsed = logisticsDeliveriesQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_filters' });
    return reply.header('Cache-Control', 'no-store').send(await listMatrizDeliveries(parsed.data));
  });
}
