import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { MatrizCentralLedgerUnavailableError } from './queries-financeiro-read-switch.js';
import { FinancialReportLimitError,financialReportQuery } from './financial-report-filter.js';
import { getFinancialReport } from './queries-financial-report.js';
import { financialReportCsv } from './financial-report-csv.js';
export async function registerFinancialReportRoutes(fastify:FastifyInstance){
  for(const operation of ['','/exportar','/imprimir'])fastify.get('/admin/api/relatorios/financeiro'+operation,{preHandler:requireAdminAuth},async(request,reply)=>{
    reply.header('Cache-Control','no-store');const parsed=financialReportQuery.safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_financial_report_filter'});
    try{const report=await getFinancialReport(parsed.data);
      if(operation==='/exportar')return reply.type('text/csv; charset=utf-8').header('Content-Disposition',`attachment; filename="financeiro-${parsed.data.view}-${parsed.data.from}-${parsed.data.to}.csv"`).send(financialReportCsv(report));
      return report;
    }catch(error){
      if(error instanceof MatrizCentralLedgerUnavailableError)return reply.code(409).send({error:'central_ledger_unavailable',reason:error.reason});
      if(error instanceof FinancialReportLimitError)return reply.code(422).send({error:'report_limit_reduce_period'});
      logger.error({err:error},'financial_report_failed');return reply.code(503).send({error:'financial_report_unavailable'});
    }
  });
}
