import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { logisticsReportQuery, LogisticsReportLimitError } from './logistics-report-filter.js';
import { getLogisticsReport } from './queries-logistics-report.js';
import { logisticsReportCsv } from './logistics-report-csv.js';

export async function registerLogisticsReportRoutes(fastify:FastifyInstance):Promise<void>{
  for(const operation of ['','/exportar','/imprimir'])fastify.get('/admin/api/relatorios/logistica'+operation,{preHandler:requireAdminAuth},async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    if(!env.MATRIZ_LOGISTICS)return reply.code(409).send({error:'logistics_disabled'});
    const parsed=logisticsReportQuery.safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_logistics_report_filter'});
    try{
      const report=await getLogisticsReport(parsed.data);
      if(operation==='/exportar')return reply.type('text/csv; charset=utf-8')
        .header('Content-Disposition',`attachment; filename="logistica-${parsed.data.view}-${parsed.data.from}-${parsed.data.to}.csv"`).send(logisticsReportCsv(report));
      return report;
    }catch(err){
      if(err instanceof LogisticsReportLimitError)return reply.code(422).send({error:'report_limit_reduce_period'});
      logger.error({err},'logistics_report_failed');return reply.code(503).send({error:'logistics_report_unavailable'});
    }
  });
}
