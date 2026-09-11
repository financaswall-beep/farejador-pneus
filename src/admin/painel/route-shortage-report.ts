import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { ShortageReportLimitError,shortageReportQuery } from './shortage-report-filter.js';
import { getShortageReport } from './queries-shortage-report.js';
import { shortageReportCsv } from './shortage-report-csv.js';
export async function registerShortageReportRoutes(app:FastifyInstance){
  for(const operation of ['','/exportar','/imprimir'])app.get('/admin/api/relatorios/faltas'+operation,{preHandler:requireAdminAuth},async(req,reply)=>{
    reply.header('Cache-Control','no-store');const parsed=shortageReportQuery.safeParse(req.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_shortage_report_filter'});
    try{const report=await getShortageReport(parsed.data);
      if(operation==='/exportar')return reply.type('text/csv; charset=utf-8').header('Content-Disposition',`attachment; filename="faltas-${parsed.data.view}-${parsed.data.from}-${parsed.data.to}.csv"`).send(shortageReportCsv(report));
      return report;
    }catch(error){if(error instanceof ShortageReportLimitError)return reply.code(422).send({error:'report_limit_reduce_period'});
      logger.error({err:error},'shortage_report_failed');return reply.code(503).send({error:'shortage_report_unavailable'});}
  });
}
