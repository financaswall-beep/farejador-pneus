import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { correctMatrizTripFuelAnnotation } from './queries-logistica-conciliacao.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';

const amount = z.number().finite().min(0).max(99999)
  .refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001, 'invalid_amount');
export const correctTripFuelSchema = z.object({
  trip_id: z.string().uuid(), amount, expected_amount: amount.nullable(),
  reason: z.string().trim().min(3).max(500),
  idempotency_key: z.string().trim().min(8).max(200),
}).strict();

export async function registerLogisticsReconciliationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/admin/api/logistica/rotas/corrigir-combustivel', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.code(404).send({ error: 'logistics_disabled' });
    const parsed = correctTripFuelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      return reply.send({ corrected: true, ...await correctMatrizTripFuelAnnotation({ ...parsed.data,
        environment: env.FAREJADOR_ENV, actor_label: operatorLabel(request) }) });
    } catch (error) {
      if (error instanceof Error && error.message === 'trip_not_found') return reply.code(404).send({ error: error.message });
      if (error instanceof Error && error.message === 'trip_fuel_annotation_changed') return reply.code(409).send({ error: error.message });
      const mapped = mapWriteError(error);
      logger.error({ err: error, status: mapped.status }, 'logistics fuel annotation correction failed');
      return reply.code(mapped.status).send({ error: mapped.error });
    }
  });
}
