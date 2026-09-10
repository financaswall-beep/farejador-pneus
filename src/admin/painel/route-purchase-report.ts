import type { FastifyInstance } from 'fastify';
import { getAdminContext, requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { getPurchaseReport } from './queries-purchase-report.js';
import { PurchaseReportLimitError } from './purchase-report-data.js';
import { purchaseReportQuery } from './purchase-report-period.js';
import { purchaseReportCsv } from './purchase-report-csv.js';

export async function registerPurchaseReportRoutes(fastify: FastifyInstance): Promise<void> {
  for (const operation of ['', '/exportar', '/imprimir']) {
    fastify.get('/admin/api/relatorios/compras' + operation, { preHandler: requireAdminAuth }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const parsed = purchaseReportQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_purchase_report_filter' });
      const context = getAdminContext(request);
      const payments = context.role === 'owner' || (context.modules ?? []).includes('financeiro');
      try {
        const report = await getPurchaseReport(parsed.data, payments);
        if (operation === '/exportar') return reply.type('text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="compras-${parsed.data.view}-${parsed.data.from}-${parsed.data.to}.csv"`)
          .send(purchaseReportCsv(report));
        const { export_purchases, ...payload } = report;
        return operation === '/imprimir' ? { ...payload, purchases: { ...payload.purchases, offset: 0, rows: export_purchases } } : payload;
      } catch (err) {
        if (err instanceof PurchaseReportLimitError) return reply.code(422).send({ error: 'report_limit_reduce_period' });
        logger.error({ err }, 'purchase_report_failed');
        return reply.code(503).send({ error: 'purchase_report_unavailable' });
      }
    });
  }
}
