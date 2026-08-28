import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPartnerContext, requirePartnerAuth, requireScreen, type PartnerAuthedRequest,
} from './auth.js';
import { getPartnerResumo } from './queries.js';

const querySchema = z.object({
  period: z.enum(['today', '7d', 'month']).default('month'),
});

export function registerPartnerSummaryRoute(fastify: FastifyInstance): void {
  fastify.get('/parceiro/:slug/api/resumo', {
    preHandler: [requirePartnerAuth, requireScreen('resumo')],
  }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'periodo_invalido' });
    const resumo = await getPartnerResumo(getPartnerContext(request), parsed.data.period);
    return reply.status(200).send({ rows: [resumo].filter(Boolean) });
  });
}
