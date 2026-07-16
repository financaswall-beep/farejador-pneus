import type { FastifyInstance } from 'fastify';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

export async function registerHealthRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/healthz', async (_request, reply) => {
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('timeout')), 2000);
    });

    try {
      await Promise.race([pool.query('SELECT 1'), timeoutPromise]);
      if (timeout) clearTimeout(timeout);
      logger.info({ environment: env.FAREJADOR_ENV }, 'health check passed');
      return reply.status(200).send({ status: 'ok', commit: env.APP_COMMIT_SHA });
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      logger.error({ err, environment: env.FAREJADOR_ENV }, 'health check failed');
      return reply.status(503).send({
        status: 'error',
        reason: 'database_unavailable',
        commit: env.APP_COMMIT_SHA,
      });
    }
  });
}
