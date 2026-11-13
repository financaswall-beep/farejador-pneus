import type { FastifyInstance,FastifyReply } from 'fastify';
import { z } from 'zod';
import { getAdminContext } from '../auth.js';
import { dotHumanOwner } from './route-oauth.js';
import { lockGrant,transact,reviewInstallment,setInstallmentPermission } from './installment-reviews.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';

const params=z.object({id:z.string().uuid()});
function fail(reply:FastifyReply,error:unknown) {
  const code=(error as Error).message;
  if (['dot_grant_unavailable','dot_review_missing'].includes(code)) return reply.code(404).send({error:'proposta_indisponivel'});
  if (code==='dot_review_expired') return reply.code(410).send({error:'proposta_expirada'});
  if (['sale_installment_changed','sale_not_found','central_obligation_not_open','central_obligation_not_actionable',
       'installment_before_sale','matrix_partner_payable_not_open'].includes(code)) return reply.code(409).send({error:'parcela_alterada'});
  logger.error({err:error},'Falha na revisão de vencimento da Milly');
  return reply.code(503).send({error:'revisao_indisponivel'});
}
export function registerInstallmentReviews(app:FastifyInstance,origin:string) {
  app.put('/admin/api/dot/connections/:id/installments',{preHandler:dotHumanOwner},async(req,reply)=>{
    if(req.headers.origin!==origin)return reply.code(403).send({error:'csrf_rejected'});
    const id=params.safeParse(req.params),body=z.object({enabled:z.boolean(),chat_confirmation:z.boolean().optional()}).strict().safeParse(req.body);
    if(!id.success||!body.success)return reply.code(400).send({error:'invalid_request'});
    try{return await setInstallmentPermission(getAdminContext(req).personId!,id.data.id,body.data.enabled,body.data.chat_confirmation);}
    catch(error){return fail(reply,error);}
  });
  app.put('/admin/api/dot/connections/:id/finance',{preHandler:dotHumanOwner},async(req,reply)=>{
    if(req.headers.origin!==origin)return reply.code(403).send({error:'csrf_rejected'});
    const id=params.safeParse(req.params),body=z.object({enabled:z.boolean()}).strict().safeParse(req.body);
    if(!id.success||!body.success)return reply.code(400).send({error:'invalid_request'});
    const person=getAdminContext(req).personId!;
    try { return await transact(async db=>{
      await lockGrant(db,person,id.data.id);
      await db.query('UPDATE network.dot_oauth_grants SET finance_operations_enabled=$3 WHERE environment=$1 AND id=$2',
        [env.FAREJADOR_ENV,id.data.id,body.data.enabled]);
      return body.data;
    }); } catch(error){return fail(reply,error);}
  });
  app.get('/admin/api/dot/installment-reviews/:id',{preHandler:dotHumanOwner},async(req,reply)=>{
    const id=params.safeParse(req.params);
    if(!id.success)return reply.code(400).send({error:'invalid_request'});
    try{return await reviewInstallment(id.data.id,{person:getAdminContext(req).personId!,action:'view'});}
    catch(error){return fail(reply,error);}
  });
  for (const action of ['confirm','restore'] as const) {
    app.post('/admin/api/dot/installment-reviews/:id/'+action,{preHandler:dotHumanOwner},async(req,reply)=>{
      if(req.headers.origin!==origin)return reply.code(403).send({error:'csrf_rejected'});
      const id=params.safeParse(req.params);
      if(!id.success || req.body!=null && !z.object({}).strict().safeParse(req.body).success)return reply.code(400).send({error:'invalid_request'});
      try{return await reviewInstallment(id.data.id,{person:getAdminContext(req).personId!,action});}
      catch(error){return fail(reply,error);}
    });
  }
}
