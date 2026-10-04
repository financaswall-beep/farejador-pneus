import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../shared/config/env.js';
import { requirePartnerAuth,requireScreen,getPartnerContext,type PartnerAuthedRequest } from './auth.js';
import { withPartnerContext } from './db.js';
import { rateLimitHit } from '../shared/rate-limit.js';

const params=z.object({requestId:z.string().uuid()});
const answer=z.object({available:z.boolean(),revision:z.number().int().positive()}).strict();
export function registerPartnerStockConfirmationRoutes(fastify:FastifyInstance) {
  const preHandler=[requirePartnerAuth,requireScreen('vendas')];
  fastify.get('/parceiro/:slug/api/operacao/confirmacoes-estoque',{preHandler},async(request:PartnerAuthedRequest,reply)=>{
    reply.header('Cache-Control','no-store');
    if(!env.PARTNER_STOCK_CONFIRMATION)return {enabled:false,rows:[]};
    const ctx=getPartnerContext(request);
    const rows=await withPartnerContext(ctx.partnerUnitId,async client=>(await client.query(
      `SELECT id,items,revision,expires_at FROM commerce.partner_stock_requests
        WHERE environment=$1 AND unit_id=$2 AND status='pending' AND sealed AND expires_at>now()
        ORDER BY expires_at,id LIMIT 30`,[ctx.environment,ctx.unitId])).rows);
    return {enabled:true,rows};
  });
  fastify.post('/parceiro/:slug/api/operacao/confirmacoes-estoque/:requestId',{preHandler},async(request:PartnerAuthedRequest,reply)=>{
    if(!env.PARTNER_STOCK_CONFIRMATION)return reply.code(404).send({error:'feature_off'});
    const id=params.safeParse(request.params);const body=answer.safeParse(request.body);
    if(!id.success||!body.success)return reply.code(400).send({error:'invalid_response'});
    const ctx=getPartnerContext(request);
    if(rateLimitHit(`stock-confirm:${ctx.tokenId}:${request.ip}`,60,60_000))return reply.code(429).send({error:'rate_limited'});
    const status=await withPartnerContext(ctx.partnerUnitId,async client=>(await client.query<{status:string}>(
      'SELECT commerce.answer_partner_stock_request($1,$2,$3) AS status',
      [id.data.requestId,body.data.revision,body.data.available])).rows[0]?.status);
    if(status==='not_found')return reply.code(404).send({error:'request_not_found'});
    if(!['confirmed','rejected'].includes(status??''))return reply.code(409).send({error:status||'request_changed'});
    // Repetir a mesma resposta é seguro; uma resposta oposta nunca vira sucesso.
    if(status!==(body.data.available?'confirmed':'rejected'))return reply.code(409).send({error:'already_answered'});
    return {ok:true,status};
  });
}
