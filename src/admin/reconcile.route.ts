import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from './auth.js';
import { ChatwootApiError } from './chatwoot-api.client.js';
import { reconcile } from './reconcile.service.js';
import { reconcileMissingAtendenteJobsWithPool } from '../atendente/reconcile-jobs.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const reconcileBodyBaseSchema = z
  .object({
    since: z.string().datetime(),
    until: z.string().datetime(),
    environment: z.enum(['prod', 'test']).optional(),
  });

const bodySchema = reconcileBodyBaseSchema.refine((value) => new Date(value.since) < new Date(value.until), {
    message: 'since must be before until',
  });

const atendenteJobsBodySchema = reconcileBodyBaseSchema.extend({
  limit: z.number().int().min(1).max(500).optional(),
}).refine((value) => new Date(value.since) < new Date(value.until), {
  message: 'since must be before until',
});

export async function registerReconcileRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post('/admin/reconcile', {
    preHandler: requireAdminAuth,
    handler: async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
      }

      const since = new Date(parsed.data.since);
      const until = new Date(parsed.data.until);
      if (until.getTime() - since.getTime() > MAX_WINDOW_MS) {
        return reply.status(400).send({ error: 'window too large, max 7 days' });
      }

      try {
        const result = await reconcile({
          since,
          until,
          environment: parsed.data.environment ?? env.FAREJADOR_ENV,
        });

        return reply.status(200).send(result);
      } catch (err) {
        // Vitest/ESM mocks can load a second copy of this class; name keeps 502 handling stable.
        if (
          err instanceof ChatwootApiError ||
          (err instanceof Error && err.name === 'ChatwootApiError')
        ) {
          const apiError = err as ChatwootApiError;
          logger.error(
            { status_code: apiError.status, body_summary: apiError.bodySummary },
            'admin reconcile failed because Chatwoot API is unavailable',
          );
          return reply.status(502).send({ error: 'chatwoot_api_unavailable' });
        }

        logger.error({ err }, 'admin reconcile failed');
        return reply.status(500).send({ error: 'internal_server_error' });
      }
    },
  });

  fastify.post('/admin/reconcile/atendente-jobs', {
    preHandler: requireAdminAuth,
    handler: async (request, reply) => {
      const parsed = atendenteJobsBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
      }

      const since = new Date(parsed.data.since);
      const until = new Date(parsed.data.until);
      if (until.getTime() - since.getTime() > MAX_WINDOW_MS) {
        return reply.status(400).send({ error: 'window too large, max 7 days' });
      }

      try {
        const result = await reconcileMissingAtendenteJobsWithPool({
          since,
          until,
          environment: parsed.data.environment ?? env.FAREJADOR_ENV,
          limit: parsed.data.limit ?? 100,
        });

        return reply.status(200).send(result);
      } catch (err) {
        logger.error({ err }, 'admin atendente jobs reconciliation failed');
        return reply.status(500).send({ error: 'internal_server_error' });
      }
    },
  });
}
