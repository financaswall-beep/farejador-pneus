import { z } from 'zod';
import { simpleFinanceQuerySchema } from './finance-query.js';
import { financialReportQuery } from '../painel/financial-report-filter.js';
import { getFinancialReport } from '../painel/queries-financial-report.js';
import { businessDateSaoPaulo } from '../../shared/business-time.js';

export const financeStatementQuery = z.object({
  period: simpleFinanceQuerySchema.shape.period.unwrap(),
  search: z.string().trim().max(120).default(''),
  direction: z.enum(['all', 'in', 'out']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(20_000).default(0),
}).strict();

/** Adapta a apresentação do relatório web. Cálculos, busca e filtros continuam no mesmo motor. */
export async function getMatrizFinanceStatement(query: z.infer<typeof financeStatementQuery>) {
  const [year, month] = query.period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
  const today = businessDateSaoPaulo(new Date());
  const report = await getFinancialReport(financialReportQuery.parse({
    from: query.period + '-01', to: lastDay < today ? lastDay : today, mode: 'month', view: 'cash',
    search: query.search, direction: query.direction,
  }));
  return {
    period: query.period, source: 'central_ledger' as const, as_of: report.as_of,
    integration_status: report.integration_status,
    summary: {
      opening: report.summary.opening, closing: report.summary.closing,
      incoming: report.summary.incoming, outgoing: report.summary.outgoing,
    },
    filtered: report.cash_filtered, total: report.cash_rows.length,
    offset: query.offset, limit: query.limit,
    rows: report.cash_rows.slice(query.offset, query.offset + query.limit),
  };
}
