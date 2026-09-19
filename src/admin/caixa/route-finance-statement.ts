import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../shared/logger.js';
import { FinancialReportLimitError } from '../painel/financial-report-filter.js';
import { financeStatementQuery, getMatrizFinanceStatement } from './finance-statement.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerCaixaFinanceStatementRoutes(
  fastify: FastifyInstance, flagGate: Gate, requireAuth: Gate, requireFinance: Gate,
) {
  fastify.get('/api/caixa/financeiro-extrato', {
    preHandler: [flagGate, requireAuth, requireFinance],
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = financeStatementQuery.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: 'invalid_finance_statement_query' });
    try {
      return await getMatrizFinanceStatement(query.data);
    } catch (error) {
      if (error instanceof FinancialReportLimitError) {
        return reply.code(422).send({ error: 'report_limit_reduce_period' });
      }
      logger.error({ err: error }, 'matrix finance statement unavailable');
      return reply.code(503).send({ error: 'finance_statement_unavailable' });
    }
  });
}
