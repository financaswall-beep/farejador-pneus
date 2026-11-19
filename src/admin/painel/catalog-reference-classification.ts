import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { applicationMeasureKey } from '../../shared/vehicle-tire-applications.js';
import { repairVehicleApplicationTypes } from '../../shared/vehicle-application-type-repair.js';
import { requireAdminOwner } from '../auth.js';
import { operatorLabel } from './route-helpers.js';

export const referenceSelection = z.object({
  measure: z.string().trim().min(1).max(60).refine(value => Boolean(applicationMeasureKey(value))),
  application_ids: z.array(z.string().min(1).max(200)).min(1).max(200)
    .refine(ids => new Set(ids).size === ids.length),
}).strict();

export function classifyMotorcycleReferences(db: PoolClient, selection: z.infer<typeof referenceSelection>, actor: string) {
  return repairVehicleApplicationTypes(db, env.FAREJADOR_ENV, selection.measure,
    { applicationIds: selection.application_ids, actor });
}

export function registerReferenceClassification(fastify: FastifyInstance) {
  fastify.post('/admin/api/catalog/measure-applications/classify-motorcycle', { preHandler: requireAdminOwner }, async (request, reply) => {
    const body = referenceSelection.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_reference_selection' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await classifyMotorcycleReferences(client, body.data, operatorLabel(request));
      await client.query('COMMIT');
      return reply.send({ changed: result.changed });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof Error && error.message === 'catalog_reference_selection_changed')
        return reply.code(409).send({ error: error.message });
      throw error;
    } finally {
      client.release();
    }
  });
}
