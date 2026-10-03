import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { logger } from '../../shared/logger.js';
import { getMatrizSimpleFinance } from './simple-finance.js';
import { getMatrizMonthlyFinance } from './monthly-finance.js';
import { simpleFinanceQuerySchema } from './finance-query.js';
import { getMatrizFinanceEntries } from './finance-entries.js';
import { getMatrizFinanceOutputs } from './finance-outputs.js';
export function registerCaixaFinanceOverview(fastify: FastifyInstance, preHandler: preHandlerHookHandler[]) {
  fastify.get('/api/caixa/financeiro-simples', {
    preHandler,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = simpleFinanceQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(parsed.data.period
        ? await getMatrizMonthlyFinance(parsed.data.period)
        : await getMatrizSimpleFinance(parsed.data.range));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'finance_unavailable';
      logger.error({ err: error }, 'simple matrix finance unavailable');
      return reply.status(503).send({ error: code });
    }
  });

  fastify.get('/api/caixa/financeiro-entradas', {
    preHandler,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = simpleFinanceQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMatrizFinanceEntries(parsed.data.range, undefined, parsed.data.period));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'finance_unavailable';
      logger.error({ err: error }, 'matrix finance entries unavailable');
      return reply.status(503).send({ error: code });
    }
  });

  fastify.get('/api/caixa/financeiro-saidas', {
    preHandler,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = simpleFinanceQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMatrizFinanceOutputs(parsed.data.range, undefined, parsed.data.period));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'finance_unavailable';
      logger.error({ err: error }, 'matrix finance outputs unavailable');
      return reply.status(503).send({ error: code });
    }
  });

}
