import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireAdminOwner,getAdminContext} from '../auth.js';
import {pool} from '../../persistence/db.js';
import {env} from '../../shared/config/env.js';
import {logger} from '../../shared/logger.js';
import {getMarketingGeography} from './queries-marketing-geography.js';
import {geographyBindingSchema,saveGeographyBinding} from './geography-config.js';
import {refreshGeographyObservations} from '../../marketing/geography-sync.js';
const query=z.object({period:z.enum(['7d','30d']).default('30d'),target:z.coerce.number().positive().max(10000).default(40)}).strict();
const params=z.object({campaignId:z.string().regex(/^\d{1,40}$/)}).strict();
const plan=z.object({period:z.enum(['7d','30d']),target:z.number().positive().max(10000),region:z.string().min(2).max(120),
  percent:z.number().min(1).max(20),days:z.number().int().min(3).max(14),request_key:z.string().uuid()}).strict();
function samePlan(row:any,campaign:string,body:z.infer<typeof plan>) {
  return row.campaign_id===campaign && row.ad_account_id===env.META_ADS_ACCOUNT_ID
    && Object.entries(body).every(([key,value])=>row.payload[key]===value);
}
function fail(reply:any,error:unknown) {
  const code=(error as {code?:string})?.code,message=error instanceof Error?error.message:'';
  if(code==='42P01')return reply.code(503).send({error:'geography_migration_required'});
  if(['geography_scope_required','geography_offer_invalid'].includes(message))return reply.code(400).send({error:message});
  if(message==='geography_binding_conflict')return reply.code(409).send({error:message});
  logger.error({err:error},'marketing geography failed');return reply.code(503).send({error:'geography_unavailable'});
}
export async function registerMarketingGeography(fastify:FastifyInstance) {
  fastify.get('/admin/api/marketing/geography',{preHandler:requireAdminOwner},async(req,reply)=>{
    const q=query.safeParse(req.query);if(!q.success)return reply.code(400).send({error:'invalid_query'});
    try{return reply.header('Cache-Control','no-store').send(await getMarketingGeography(q.data.period,q.data.target));}catch(e){return fail(reply,e);}
  });
  fastify.post('/admin/api/marketing/geography/refresh',{preHandler:requireAdminOwner},async(req,reply)=>{
    if(!z.object({}).strict().safeParse(req.body??{}).success)return reply.code(400).send({error:'invalid_body'});
    try{await refreshGeographyObservations(true);return reply.send({ok:true});}catch(e){return fail(reply,e);}
  });
  fastify.post('/admin/api/marketing/geography/:campaignId/binding',{preHandler:requireAdminOwner},async(req,reply)=>{
    const p=params.safeParse(req.params),b=geographyBindingSchema.safeParse(req.body);
    if(!p.success||!b.success)return reply.code(400).send({error:'invalid_binding'});
    if(!env.META_ADS_ACCOUNT_ID)return reply.code(409).send({error:'marketing_meta_not_configured'});
    try{return reply.send(await saveGeographyBinding(pool,env.FAREJADOR_ENV,env.META_ADS_ACCOUNT_ID,p.data.campaignId,b.data,getAdminContext(req).displayName));}
    catch(e){return fail(reply,e);}
  });
  fastify.post('/admin/api/marketing/geography/:campaignId/plans',{preHandler:requireAdminOwner},async(req,reply)=>{
    const p=params.safeParse(req.params),b=plan.safeParse(req.body);
    if(!p.success||!b.success)return reply.code(400).send({error:'invalid_plan'});
    try {
      const existingSql=`SELECT id,payload,campaign_id,ad_account_id FROM marketing.geography_test_plans WHERE environment=$1 AND request_key=$2`;
      const key=[env.FAREJADOR_ENV,b.data.request_key];
      const existing=(await pool.query(existingSql,key)).rows[0];
      if(existing)return samePlan(existing,p.data.campaignId,b.data)?reply.send({id:existing.id,payload:existing.payload}):reply.code(409).send({error:'geography_plan_conflict'});
      const report=await getMarketingGeography(b.data.period,b.data.target);
      const c=report.records.find(r=>r.id===p.data.campaignId&&r.region===b.data.region);
      if(!c||c.decision!=='increase'||!c.meta?.daily_budget||!c.meta?.budget_entity_id)return reply.code(409).send({error:'geography_plan_not_ready'});
      const payload={...b.data,campaign:c.name,campaign_id:c.id,budget_entity_id:c.meta.budget_entity_id,budget_level:c.meta.budget_level,
        before:c.meta.daily_budget,proposed:Math.round(c.meta.daily_budget*(1+b.data.percent/100)*100)/100,
        totals:c.totals,reasons:c.reasons,status:'draft',meta_changed:false,generated_at:report.generated_at};
      const result=await pool.query(`INSERT INTO marketing.geography_test_plans(id,environment,ad_account_id,campaign_id,request_key,payload,created_by)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(environment,request_key) DO NOTHING RETURNING id,payload`,
        [randomUUID(),env.FAREJADOR_ENV,env.META_ADS_ACCOUNT_ID,c.id,b.data.request_key,JSON.stringify(payload),getAdminContext(req).displayName]);
      const saved=result.rows[0]??(await pool.query(existingSql,key)).rows[0];
      if(!result.rowCount&&!samePlan(saved,p.data.campaignId,b.data))return reply.code(409).send({error:'geography_plan_conflict'});
      return reply.header('Cache-Control','no-store').send({id:saved.id,payload:saved.payload});
    }catch(e){return fail(reply,e);}
  });
}
