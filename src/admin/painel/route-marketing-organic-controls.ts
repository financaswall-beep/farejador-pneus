import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { pool } from '../../persistence/db.js';
import { requireAdminOwner,getAdminContext } from '../auth.js';
import { organicInboxes,organicRuntimeReady,verifyOrganicInbox } from '../../marketing/organic/controls.js';
import { recordMarketingAudit } from './marketing-audit.js';

export async function registerOrganicControls(app:FastifyInstance) {
  const options={preHandler:requireAdminOwner};
  app.get('/admin/api/marketing/organic/controls',options,async(_request,reply)=>{
    if(!env.ORGANIC_ATTRIBUTION_ENABLED)return {available:false,channels:[],interests:[]};
    try {
      const controls=await pool.query(`SELECT platform,enabled,activated_at,verified_inbox_id,verified_at
        FROM ops.organic_controls WHERE environment=$1`,[env.FAREJADOR_ENV]);
      const interests=await pool.query(`SELECT s.id,s.tire_size,s.tire_condition,s.phone_e164,s.consent_at,
        c.chatwoot_conversation_id FROM ops.stock_interests s JOIN core.conversations c
        ON c.environment=s.environment AND c.id=s.conversation_id
        WHERE s.environment=$1 AND s.status='pending' AND c.deleted_at IS NULL ORDER BY s.consent_at LIMIT 100`,[env.FAREJADOR_ENV]);
      let inboxes:Awaited<ReturnType<typeof organicInboxes>>=[];
      try {inboxes=await organicInboxes();}catch{}
      return reply.header('Cache-Control','no-store').send({available:true,inboxes,interests:interests.rows,
        channels:['instagram','facebook'].map(platform=>({platform,enabled:false,...controls.rows.find(r=>r.platform===platform),runtime_ready:organicRuntimeReady(platform)}))});
    }catch{return reply.code(503).send({error:'organic_controls_unavailable'});}
  });
  app.post('/admin/api/marketing/organic/controls',options,async(request,reply)=>{
    const parsed=z.object({platform:z.enum(['instagram','facebook']),action:z.enum(['verify','enable','disable']),inbox_id:z.number().int().positive().optional()}).strict().safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_body'});
    if(!env.ORGANIC_ATTRIBUTION_ENABLED)return reply.code(409).send({error:'organic_disabled'});
    const {platform,action,inbox_id}=parsed.data, actor=getAdminContext(request).displayName;
    try {
      if(action==='verify') {
        if(!inbox_id)return reply.code(400).send({error:'inbox_required'});
        await verifyOrganicInbox(pool,platform,inbox_id,actor);
      }else if(action==='disable') {
        await pool.query(`UPDATE ops.organic_controls SET enabled=false,updated_by=$3,updated_at=now() WHERE environment=$1 AND platform=$2`,[env.FAREJADOR_ENV,platform,actor]);
      }else {
        if(!organicRuntimeReady(platform))return reply.code(409).send({error:'organic_runtime_not_ready'});
        const saved=await pool.query(`SELECT verified_inbox_id FROM ops.organic_controls WHERE environment=$1 AND platform=$2`,[env.FAREJADOR_ENV,platform]);
        if(!saved.rows[0]?.verified_inbox_id)return reply.code(409).send({error:'organic_inbound_test_required'});
        await verifyOrganicInbox(pool,platform,Number(saved.rows[0].verified_inbox_id),actor);
        await pool.query(`UPDATE ops.organic_controls SET enabled=true,activated_at=now(),updated_at=now(),updated_by=$3
          WHERE environment=$1 AND platform=$2`,[env.FAREJADOR_ENV,platform,actor]);
      }
      await recordMarketingAudit({eventType:'organic_'+action,actorLabel:actor,entityTable:'ops.organic_controls',payload:{platform}});
      return {ok:true};
    }catch(error){const code=error instanceof Error?error.message:'';
      return reply.code(409).send({error:['organic_inbox_mismatch','organic_messaging_permissions_missing','organic_inbound_test_required'].includes(code)?code:'organic_verification_unavailable'});}
  });
  app.post('/admin/api/marketing/organic/interests/:id',options,async(request,reply)=>{
    const params=z.object({id:z.string().uuid()}).safeParse(request.params);
    const body=z.object({status:z.enum(['contacted','cancelled'])}).strict().safeParse(request.body);
    if(!params.success || !body.success)return reply.code(400).send({error:'invalid_body'});
    if(!env.ORGANIC_ATTRIBUTION_ENABLED)return reply.code(409).send({error:'organic_disabled'});
    const actor=getAdminContext(request).displayName;
    const result=await pool.query(`UPDATE ops.stock_interests SET status=$3,updated_by=$4,updated_at=now()
      WHERE environment=$1 AND id=$2 AND status='pending' RETURNING id`,[env.FAREJADOR_ENV,params.data.id,body.data.status,actor]);
    if(!result.rowCount)return reply.code(404).send({error:'interest_not_found'});
    await recordMarketingAudit({eventType:'stock_interest_'+body.data.status,actorLabel:actor,entityTable:'ops.stock_interests',entityId:params.data.id,payload:{}});
    return {ok:true};
  });
}
