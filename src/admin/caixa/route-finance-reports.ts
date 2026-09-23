import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../shared/logger.js';
import { financialReportQuery, FinancialReportLimitError } from '../painel/financial-report-filter.js';
import { getFinancialReport } from '../painel/queries-financial-report.js';
import { financialReportCsv } from '../painel/financial-report-csv.js';
import { MatrizCentralLedgerUnavailableError } from '../painel/queries-financeiro-read-switch.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export function registerCaixaFinanceReportRoutes(app: FastifyInstance, flag: Gate, auth: Gate, finance: Gate) {
  for (const operation of ['', '/exportar', '/imprimir']) {
    app.get('/api/caixa/financeiro-relatorios' + operation, { preHandler: [flag, auth, finance] }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const parsed = financialReportQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_financial_report_filter' });
      try {
        const report = await getFinancialReport(parsed.data);
        if (operation === '/exportar') return reply.type('text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="financeiro-${parsed.data.view}-${parsed.data.from}-${parsed.data.to}.csv"`)
          .send(financialReportCsv(report));
        return report;
      } catch (error) {
        if (error instanceof MatrizCentralLedgerUnavailableError) return reply.code(409).send({ error: 'central_ledger_unavailable' });
        if (error instanceof FinancialReportLimitError) return reply.code(422).send({ error: 'report_limit_reduce_period' });
        logger.error({ err: error }, 'app financial report unavailable');
        return reply.code(503).send({ error: 'financial_report_unavailable' });
      }
    });
  }
}
