import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../shared/config/env.js';
import { pool } from '../persistence/db.js';
import { waitlistRows,waitlistReport,changeWaitlistStatus } from './stock-waitlist.js';
import { getCustomerLeadAvatar } from './painel/customer-lead-avatar.js';
type Guard=(r:FastifyRequest,p:FastifyReply)=>Promise<void>;
const query=z.object({search:z.string().trim().max(100).default(''),vehicle:z.enum(['','car','motorcycle']).default(''),
  region:z.string().max(100).default(''),status:z.enum(['all','ready','waiting','history']).default('all'),
  offset:z.coerce.number().int().min(0).max(10000).default(0)});
const idSchema=z.object({id:z.string().uuid()});
export function registerStockWaitlistRoutes(app:FastifyInstance,prefix:string,guards:Guard[],actor:(r:FastifyRequest)=>string) {
  const handle=async(reply:FastifyReply,work:()=>Promise<unknown>)=>{
    reply.header('Cache-Control','private, no-store');
    try{return await work();}catch(e){
      const code=e instanceof Error?e.message:'';
      if(code==='waitlist_conflict')return reply.code(409).send({error:code});
      if(code==='waitlist_not_found')return reply.code(404).send({error:code});
      app.log.error({err:e},'stock waitlist request failed');
      return reply.code(503).send({error:'waitlist_unavailable'});
    }
  };
  app.get(prefix,{preHandler:guards},async(req,reply)=>{
    const q=query.safeParse(req.query);if(!q.success)return reply.code(400).send({error:'invalid_query'});
    return handle(reply,async()=>waitlistReport(await waitlistRows(),q.data));
  });
  app.get(prefix+'/:id/avatar',{preHandler:guards},async(req,reply)=>{
    const p=idSchema.safeParse(req.params);if(!p.success)return reply.code(400).send({error:'invalid_id'});
    return handle(reply,async()=>{
      const row=(await pool.query(`SELECT s.conversation_id FROM ops.stock_interests s JOIN core.conversations c
        ON c.id=s.conversation_id AND c.environment=s.environment JOIN core.contacts ct ON ct.id=c.contact_id
        AND ct.environment=c.environment AND ct.deleted_at IS NULL WHERE s.environment=$1 AND s.id=$2
        AND c.chatwoot_account_id=$3 AND c.deleted_at IS NULL`,[env.FAREJADOR_ENV,p.data.id,env.CHATWOOT_ACCOUNT_ID])).rows[0];
      if(!row)throw Error('waitlist_not_found');
      return {url:await getCustomerLeadAvatar(row.conversation_id,env.FAREJADOR_ENV)};
    });
  });
  // Reconsulta saldo antes de abrir o WhatsApp; abrir não equivale a enviar.
  app.get(prefix+'/:id',{preHandler:guards},async(req,reply)=>{
    const p=idSchema.safeParse(req.params);if(!p.success)return reply.code(400).send({error:'invalid_id'});
    return handle(reply,async()=>{const row=(await waitlistRows()).find(r=>r.id===p.data.id);
      if(!row)throw Error('waitlist_not_found');return row;});
  });
  app.post(prefix+'/:id',{preHandler:guards},async(req,reply)=>{
    const p=idSchema.safeParse(req.params),b=z.object({version:z.number().int().min(0),status:z.enum(['contacted','cancelled'])}).strict().safeParse(req.body);
    if(!p.success||!b.success)return reply.code(400).send({error:'invalid_body'});
    return handle(reply,()=>changeWaitlistStatus(p.data.id,b.data.version,b.data.status,actor(req)));
  });
}
