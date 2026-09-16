import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth,getAdminContext } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { dashboardPayload } from './route-helpers.js';
import { getMatrizOverview,overviewPeriod } from './matriz-overview.js';
const query=z.object({period:z.enum(['today','7d','month']),month:z.string()}).strict();
export async function registerMatrizOverview(app:FastifyInstance) {
  app.get('/admin/api/dashboard/matriz-overview',{preHandler:requireAdminAuth},async(request,reply)=>{
    const parsed=query.safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_query'});
    let period;
    try{period=overviewPeriod(parsed.data.period,parsed.data.month);}
    catch{return reply.code(400).send({error:'invalid_month'});}
    const context=getAdminContext(request);
    try {
      const overview=await getMatrizOverview(period,context.role==='owner'||context.modules?.includes('financeiro')===true);
      return reply.header('Cache-Control','no-store').send({...dashboardPayload([]),...overview});
    }catch(error){
      logger.error({error},'matriz overview read failed');
      return reply.code(503).send({error:'overview_unavailable'});
    }
  });
}
