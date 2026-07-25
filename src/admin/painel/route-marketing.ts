/**
 * Marketing da matriz — endpoint owner-only e read-only.
 * Falha da plataforma externa aparece no payload; nunca derruba outras abas.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { getMarketingOverview } from './queries.js';

const querySchema = z.object({
  period: z.enum(['7d', '30d']).default('30d'),
}).strict();

export async function registerPainelMarketing(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/marketing/overview', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMarketingOverview(parsed.data.period));
    } catch (err) {
      logger.error({ err }, 'painel marketing overview failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });
}
