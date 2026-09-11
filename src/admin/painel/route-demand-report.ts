import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { demandReportQuery,DemandReportLimitError } from './demand-report-filter.js';
import { getDemandReport } from './queries-demand-report.js';
import { demandReportCsv } from './demand-report-csv.js';
export async function registerDemandReportRoutes(app:FastifyInstance){
  for(const operation of ['','/exportar','/imprimir'])app.get('/admin/api/relatorios/demanda'+operation,{preHandler:requireAdminAuth},async(req,reply)=>{
    reply.header('Cache-Control','no-store');const parsed=demandReportQuery.safeParse(req.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_demand_report_filter'});
    try{const report=await getDemandReport(parsed.data);
      if(operation==='/exportar')return reply.type('text/csv; charset=utf-8').header('Content-Disposition',`attachment; filename="demanda-${parsed.data.view}-${parsed.data.from}-${parsed.data.to}.csv"`).send(demandReportCsv(report));
      return report;
    }catch(error){if(error instanceof DemandReportLimitError)return reply.code(422).send({error:'report_limit_reduce_period'});
      logger.error({err:error},'demand_report_failed');return reply.code(503).send({error:'demand_report_unavailable'});}
  });
}
