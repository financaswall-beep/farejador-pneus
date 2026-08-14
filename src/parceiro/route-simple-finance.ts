import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPartnerContext, requireOwner, requirePartnerAuth } from './auth.js';
import type { PartnerAuthedRequest } from './auth.js';
import { getPartnerSimpleFinance } from './simple-finance.js';

const querySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

/** Valores consolidados do app operacional ficam exclusivos do proprietário. */
export function registerPartnerSimpleFinanceRoute(fastify: FastifyInstance): void {
  fastify.get('/parceiro/:slug/api/financeiro-simples', {
    preHandler: [requirePartnerAuth, requireOwner],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(await getPartnerSimpleFinance(
      getPartnerContext(request), parsed.data.period,
    ));
  });
}
