import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool } from '../persistence/db.js';
import { partnerPool } from '../parceiro/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { assertRequiredSchema } from '../persistence/required-schema.js';
import { inspectOperationalContinuity, type OperationalContinuity } from './operational-health.js';

type CheckStatus = 'ok' | 'error';
type Checks = {
  database: CheckStatus;
  database_schema: CheckStatus;
  partner_database: CheckStatus;
  operational_continuity: CheckStatus;
};

async function withinReadinessDeadline<T>(query: () => Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('readiness_timeout')), 2000);
  });
  try {
    return await Promise.race([query(), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function checkDatabase(query: () => Promise<unknown>): Promise<CheckStatus> {
  try {
    await withinReadinessDeadline(query);
    return 'ok';
  } catch {
    return 'error';
  }
}

function sendReadiness(
  reply: FastifyReply,
  checks: Checks,
  operational: OperationalContinuity,
): FastifyReply {
  const ready = Object.values(checks).every((status) => status === 'ok');
  if (ready) return reply.status(200).send({
    status: operational.warnings.length ? 'degraded' : 'ok',
    checks,
    warnings: operational.warnings,
    operational: operational.details,
    commit: env.APP_COMMIT_SHA,
  });
  return reply.status(503).send({
    status: 'error',
    reason: 'dependency_unavailable',
    checks,
    warnings: operational.warnings,
    operational: operational.details,
    commit: env.APP_COMMIT_SHA,
  });
}

export async function registerHealthRoute(fastify: FastifyInstance): Promise<void> {
  let previousReady: boolean | undefined;

  fastify.get('/livez', async (_request, reply) =>
    reply.status(200).send({ status: 'ok', commit: env.APP_COMMIT_SHA }));

  fastify.get('/operational-healthz', async (_request, reply) => {
    try {
      const operational = await withinReadinessDeadline(
        () => inspectOperationalContinuity(pool, env.FAREJADOR_ENV),
      );
      const code = operational.critical.length ? 503 : 200;
      return reply.status(code).send({
        status: operational.critical.length ? 'error'
          : operational.warnings.length ? 'degraded' : 'ok',
        ...operational,
        commit: env.APP_COMMIT_SHA,
      });
    } catch {
      return reply.status(503).send({ status: 'error', reason: 'operational_check_unavailable' });
    }
  });

  const readinessHandler = async (_request: unknown, reply: FastifyReply): Promise<FastifyReply> => {
    const [database, databaseSchema, partnerDatabase, operational] = await Promise.all([
      checkDatabase(() => pool.query('SELECT 1')),
      checkDatabase(() => assertRequiredSchema(pool)),
      checkDatabase(() => partnerPool.query('SELECT 1')),
      withinReadinessDeadline(
        () => inspectOperationalContinuity(pool, env.FAREJADOR_ENV),
      ).catch(() => ({
        critical: ['operational_check_unavailable'],
        warnings: [],
        details: {
          schema_version: 0, schema_migration_name: null,
          migration_ledger_rows: 0, migration_ledger_version: 0,
          migration_ledger_latest: null,
          missing_partitions: 0, latest_raw_event: null,
          latest_meta_success: null, open_dead_letters: 0, cron_history_bytes: 0,
        },
      })),
    ]);
    const checks: Checks = {
      database,
      database_schema: databaseSchema,
      partner_database: partnerDatabase,
      operational_continuity: operational.critical.length ? 'error' : 'ok',
    };
    const ready = Object.values(checks).every((status) => status === 'ok');

    if (ready && previousReady === false) {
      logger.info({ operational_alert: 'readiness_recovered', checks }, 'service readiness recovered');
    } else if (!ready && previousReady !== false) {
      logger.error({ operational_alert: 'readiness_failed', checks }, 'service is not ready');
    }
    previousReady = ready;
    return sendReadiness(reply, checks, operational);
  };

  fastify.get('/readyz', readinessHandler);
  // Compatibilidade operacional: healthz continua existindo, agora como readiness.
  fastify.get('/healthz', readinessHandler);
}
