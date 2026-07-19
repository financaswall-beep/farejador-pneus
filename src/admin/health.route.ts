import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool } from '../persistence/db.js';
import { partnerPool } from '../parceiro/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

type CheckStatus = 'ok' | 'error';
type Checks = { database: CheckStatus; partner_database: CheckStatus };

async function checkDatabase(query: () => Promise<unknown>): Promise<CheckStatus> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('readiness_timeout')), 2000);
  });
  try {
    await Promise.race([query(), deadline]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sendReadiness(reply: FastifyReply, checks: Checks): FastifyReply {
  const ready = Object.values(checks).every((status) => status === 'ok');
  if (ready) return reply.status(200).send({ status: 'ok', checks, commit: env.APP_COMMIT_SHA });
  return reply.status(503).send({
    status: 'error',
    reason: 'dependency_unavailable',
    checks,
    commit: env.APP_COMMIT_SHA,
  });
}

export async function registerHealthRoute(fastify: FastifyInstance): Promise<void> {
  let previousReady: boolean | undefined;

  fastify.get('/livez', async (_request, reply) =>
    reply.status(200).send({ status: 'ok', commit: env.APP_COMMIT_SHA }));

  const readinessHandler = async (_request: unknown, reply: FastifyReply): Promise<FastifyReply> => {
    const [database, partnerDatabase] = await Promise.all([
      checkDatabase(() => pool.query('SELECT 1')),
      checkDatabase(() => partnerPool.query('SELECT 1')),
    ]);
    const checks: Checks = { database, partner_database: partnerDatabase };
    const ready = database === 'ok' && partnerDatabase === 'ok';

    if (ready && previousReady === false) {
      logger.info({ operational_alert: 'readiness_recovered', checks }, 'service readiness recovered');
    } else if (!ready && previousReady !== false) {
      logger.error({ operational_alert: 'readiness_failed', checks }, 'service is not ready');
    }
    previousReady = ready;
    return sendReadiness(reply, checks);
  };

  fastify.get('/readyz', readinessHandler);
  // Compatibilidade operacional: healthz continua existindo, agora como readiness.
  fastify.get('/healthz', readinessHandler);
}
