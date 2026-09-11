import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { PartnerReportLimitError,partnerReportQuery } from './partner-report-filter.js';
import { getPartnerReport } from './queries-partner-report.js';
import { partnerReportCsv } from './partner-report-csv.js';
export async function registerPartnerReportRoutes(app:FastifyInstance){
  for(const operation of ['','/exportar','/imprimir'])app.get('/admin/api/relatorios/parceiros'+operation,{preHandler:requireAdminAuth},async(req,reply)=>{
    reply.header('Cache-Control','no-store');const parsed=partnerReportQuery.safeParse(req.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_partner_report_filter'});
    try{const report=await getPartnerReport(parsed.data);
      if(operation==='/exportar')return reply.type('text/csv; charset=utf-8').header('Content-Disposition',`attachment; filename="parceiros-${parsed.data.view}-${parsed.data.from}-${parsed.data.to}.csv"`).send(partnerReportCsv(report));
      return report;
    }catch(error){if(error instanceof PartnerReportLimitError)return reply.code(422).send({error:'report_limit_reduce_period'});
      logger.error({err:error},'partner_report_failed');return reply.code(503).send({error:'partner_report_unavailable'});}
  });
}
