import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { stockReportQuery,StockReportLimitError } from './stock-report-filter.js';
import { getStockReport } from './queries-stock-report.js';
import { stockReportCsv } from './stock-report-csv.js';

export async function registerStockReportRoutes(fastify:FastifyInstance):Promise<void>{
  for(const operation of ['','/exportar','/imprimir'])fastify.get('/admin/api/relatorios/estoque'+operation,{preHandler:requireAdminAuth},async(request,reply)=>{
    reply.header('Cache-Control','no-store');const parsed=stockReportQuery.safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_stock_report_filter'});
    try{
      const report=await getStockReport(parsed.data);
      if(operation==='/exportar')return reply.type('text/csv; charset=utf-8')
        .header('Content-Disposition',`attachment; filename="estoque-${parsed.data.view}-${report.to}.csv"`).send(stockReportCsv(report));
      const {export_movements,...payload}=report;
      return operation==='/imprimir'?{...payload,movements:{...payload.movements,offset:0,rows:export_movements}}:payload;
    }catch(err){
      if(err instanceof StockReportLimitError)return reply.code(422).send({error:err.message});
      logger.error({err},'stock_report_failed');return reply.code(503).send({error:'stock_report_unavailable'});
    }
  });
}
