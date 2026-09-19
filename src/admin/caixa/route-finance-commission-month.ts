import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CaixaAuth } from './queries.js';
import { simpleFinanceQuerySchema } from './finance-query.js';
import { getFinanceCommissionMonth, getFinanceCommissionMonthDetail } from './finance-commission-month.js';
import { logger } from '../../shared/logger.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const query = z.object({ period: simpleFinanceQuerySchema.shape.period.unwrap() }).strict();
const detailQuery = query.extend({ target: z.string().uuid().optional(), offset: z.coerce.number().int().min(0).max(100_000).default(0) });
export function registerCaixaFinanceCommissionMonthRoutes(app: FastifyInstance, flag: Gate, auth: Gate, finance: Gate) {
  const guards = [flag, auth, finance, async (request: FastifyRequest, reply: FastifyReply) => {
    if ((request as FastifyRequest & { caixa?: CaixaAuth }).caixa?.panelRole !== 'owner') await reply.code(403).send({ error: 'owner_required' });
  }];
  app.get('/api/caixa/financeiro-comissoes-mes', { preHandler: guards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = query.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    try { return await getFinanceCommissionMonth(parsed.data.period); }
    catch (err) { logger.error({ err }, 'monthly commissions unavailable'); return reply.code(503).send({ error: 'commission_unavailable' }); }
  });
  app.get('/api/caixa/financeiro-comissoes-mes/:id', { preHandler: guards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = detailQuery.safeParse(request.query), params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success || !params.success) return reply.code(400).send({ error: 'invalid_query' });
    try {
      const data = await getFinanceCommissionMonthDetail(parsed.data.period, params.data.id, parsed.data.target, parsed.data.offset);
      return data ?? reply.code(404).send({ error: 'commission_not_found' });
    } catch (err) { logger.error({ err }, 'monthly commission detail unavailable'); return reply.code(503).send({ error: 'commission_unavailable' }); }
  });
}
