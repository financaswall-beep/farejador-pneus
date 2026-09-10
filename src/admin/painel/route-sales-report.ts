import type { FastifyInstance } from 'fastify';
import { getAdminContext, requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { getSalesReport } from './queries-sales-report.js';
import { SalesReportLimitError } from './sales-report-data.js';
import { salesReportQuery } from './sales-report-period.js';

export function salesReportCsvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export async function registerSalesReportRoutes(fastify: FastifyInstance): Promise<void> {
  for (const operation of ['', '/exportar', '/imprimir']) {
    fastify.get('/admin/api/relatorios/vendas' + operation, { preHandler: requireAdminAuth }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const parsed = salesReportQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_sales_report_filter' });
      const context = getAdminContext(request);
      const showCosts = context.role === 'owner' || (context.modules ?? []).includes('financeiro');
      try {
        const report = await getSalesReport(parsed.data, showCosts);
        if (operation === '/exportar') {
          const formatMoney = (n: number | null) => n === null ? 'Custo pendente' : n.toFixed(2).replace('.', ',');
          const columns = ['Venda', 'Data (São Paulo)', 'Canal', 'Medida / item', 'Marca', 'Condição', 'Quantidade', 'Valor dos itens'];
          if (showCosts) columns.push('Custo histórico', 'Margem bruta');
          const rows = report.export_sales.flatMap(sale => sale.items.map(item => {
            const cells: unknown[] = [sale.id, sale.day, sale.channel, item.measure, item.brand, item.condition, item.quantity, formatMoney(item.revenue)];
            if (showCosts) cells.push(formatMoney(item.cost), formatMoney(item.margin));
            return cells;
          }));
          return reply.type('text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="vendas-${parsed.data.from}-${parsed.data.to}.csv"`)
            .send('\uFEFF' + [columns, ...rows].map(row => row.map(salesReportCsvCell).join(';')).join('\r\n'));
        }
        const { export_sales, ...payload } = report;
        // PDF is rendered locally from the same complete, filtered snapshot.
        return operation === '/imprimir' ? { ...payload, sales: { ...payload.sales, offset: 0, rows: export_sales } } : payload;
      } catch (err) {
        if (err instanceof SalesReportLimitError) return reply.code(422).send({ error: 'report_limit_reduce_period' });
        logger.error({ err }, 'sales_report_failed');
        return reply.code(503).send({ error: 'sales_report_unavailable' });
      }
    });
  }
}
