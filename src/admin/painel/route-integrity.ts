import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { resolveIntegrityOperation } from './stage5-integrity.js';
import { mapWriteError } from './route-helpers.js';
import { resolveIntegrityOperationSchema } from './route-schemas.js';

/** Recupera o desfecho de uma criacao depois de reload/resposta perdida.
 * Nao aceita dominios arbitrarios: a borda expoe somente formularios "novos". */
export async function registerPainelIntegrity(fastify: FastifyInstance): Promise<void> {
  fastify.post('/admin/api/integrity/resolve', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = resolveIntegrityOperationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await resolveIntegrityOperation(client, {
        environment: env.FAREJADOR_ENV,
        domain: parsed.data.domain,
        idempotencyKey: parsed.data.idempotency_key,
      });
      await client.query('COMMIT');
      return reply.status(200).send(result);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const mapped = mapWriteError(error);
      logger.error({ err: error, status: mapped.status }, 'painel integrity resolve failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    } finally {
      client.release();
    }
  });
}
