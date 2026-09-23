import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { pool } from '../../persistence/db.js';
import { rateLimitHit } from '../../shared/rate-limit.js';
import { subscribeClientesKanban } from '../../shared/clientes-kanban.notify.js';
import { acquirePartnerSseSlot } from '../../parceiro/sse-limit.js';
import { changeBotConversationControl } from '../painel/bot-conversation-control.js';
import { getCustomerLeadAvatar } from '../painel/customer-lead-avatar.js';
import { getCustomerDetail } from '../painel/customer-detail.js';
import { getOperationConversation,getOperationMessages,listOperationConversations,requireChatConversation } from './chat-queries.js';
import { queueOperatorMessage, retryOperatorMessage } from './chat-send.js';
import { parseOperatorMedia,CHAT_MEDIA_MAX } from './chat-media.js';
import type { CaixaAuth } from './queries.js';
import { pollBotOutbox } from '../../atendente-v2/outbound-worker.js';
import { getChatwootChannelHealth } from '../chatwoot-channel-health.js';
import { getOperationCustomerInterests } from './chat-customer-interests.js';

type Guard=(request:FastifyRequest,reply:FastifyReply)=>Promise<void>;
type Request=FastifyRequest & {caixa?:CaixaAuth};
const params=z.object({id:z.string().uuid()});
const listQuery=z.object({search:z.string().trim().max(100).default(''),filter:z.enum(['all','needs','bot']).default('needs'),
  channel:z.enum(['','whatsapp','instagram','facebook','web']).default(''),offset:z.coerce.number().int().min(0).max(10000).default(0),
  closed:z.enum(['true','false']).default('false').transform(v=>v==='true')});
const sendBody=z.object({client_token:z.string().uuid(),content:z.string().trim().max(4000).default(''),
  photo_request_id:z.string().uuid().optional(),
  file:z.object({mime:z.string().max(80),base64:z.string().max(Math.ceil(CHAT_MEDIA_MAX/3)*4)}).optional()})
  .strict().refine(v=>v.content.length>0 || !!v.file);

export function canAccessOperationChat(auth?:CaixaAuth):boolean {
  // Mesma proteção dos leads do painel enquanto a identidade de clientes está restrita ao proprietário.
  return !!auth?.modules.vendas && (!env.MATRIZ_CUSTOMER_IDENTITY || auth.panelRole==='owner');
}
export function registerCaixaChatRoutes(app:FastifyInstance,flag:Guard,auth:Guard) {
  const access:Guard=async(req,reply)=>{if(!canAccessOperationChat((req as Request).caixa)) await reply.code(403).send({error:'forbidden'});};
  const ready:Guard=async(_req,reply)=>{
    reply.header('Cache-Control','private, no-store');
    const result=await pool.query(`SELECT to_regclass('ops.operator_messages') IS NOT NULL AS ready`);
    if(!result.rows[0]?.ready) await reply.code(503).send({error:'chat_migration_required'});
  };
  const guards=[flag,auth,access,ready];
  app.get('/api/caixa/chat/channels',{preHandler:[flag,auth,access]},async(_req,reply)=>{
    reply.header('Cache-Control','private, no-store');
    return getChatwootChannelHealth();
  });
  const respond=async(reply:FastifyReply,work:()=>Promise<unknown>)=>{
    try{return await work();}catch(error){
      const message=error instanceof Error?error.message:'';
      const code=message==='bot_conversation_not_found'?404:message.includes('conflict')?409:
        message==='chat_media_invalid'?415:message==='chat_delivery_disabled'?503:500;
      if(code===500) app.log.error({err:error},'operation chat failed');
      return reply.code(code).send({error:code===500?'chat_unavailable':message});
    }
  };
  app.get('/api/caixa/chat/conversations',{preHandler:guards},async(req,reply)=>{
    const query=listQuery.safeParse(req.query);if(!query.success)return reply.code(400).send({error:'invalid_query'});
    return respond(reply,()=>listOperationConversations(query.data));
  });
  app.get('/api/caixa/chat/conversations/:id',{preHandler:guards},async(req,reply)=>{
    const parsed=params.safeParse(req.params);if(!parsed.success)return reply.code(400).send({error:'invalid_id'});
    return respond(reply,()=>getOperationConversation(parsed.data.id));
  });
  app.get('/api/caixa/chat/conversations/:id/messages',{preHandler:guards},async(req,reply)=>{
    const p=params.safeParse(req.params),q=z.object({at:z.string().datetime({offset:true}).optional(),before:z.string().uuid().optional()}).safeParse(req.query);
    if(!p.success||!q.success||Boolean(q.data.at)!==Boolean(q.data.before))return reply.code(400).send({error:'invalid_query'});
    return respond(reply,()=>getOperationMessages(p.data.id,q.data.at?{at:q.data.at,id:q.data.before!}:undefined));
  });
  app.post('/api/caixa/chat/conversations/:id/messages',{preHandler:guards,bodyLimit:Math.ceil(CHAT_MEDIA_MAX*1.4)+10000},async(req:Request,reply)=>{
    const p=params.safeParse(req.params),body=sendBody.safeParse(req.body);
    if(!p.success||!body.success)return reply.code(400).send({error:'invalid_message'});
    if(rateLimitHit(`operator-chat:${req.caixa!.personId}`,30,60000))return reply.code(429).send({error:'rate_limited'});
    return respond(reply,async()=>{
      await requireChatConversation(p.data.id);
      const file=body.data.file?await parseOperatorMedia(body.data.file):undefined;
      const result=await queueOperatorMessage({conversationId:p.data.id,clientToken:body.data.client_token,
        actor:`caixa:${req.caixa!.personId}`,content:body.data.content,file,photoRequestId:body.data.photo_request_id});
      // A fila continua sendo a dona do envio. Este wake-up apenas evita esperar o próximo poll.
      void pollBotOutbox().catch(error=>app.log.error({err:error},'operator outbox wake failed'));
      return reply.code(202).send(result);
    });
  });
  app.post('/api/caixa/chat/conversations/:id/messages/:messageId/retry',{preHandler:guards},async(req:Request,reply)=>{
    const p=z.object({id:z.string().uuid(),messageId:z.string().uuid()}).safeParse(req.params);
    if(!p.success)return reply.code(400).send({error:'invalid_id'});
    if(rateLimitHit(`operator-chat:${req.caixa!.personId}`,30,60000))return reply.code(429).send({error:'rate_limited'});
    return respond(reply,async()=>{
      const result=await retryOperatorMessage(p.data.id,p.data.messageId,`caixa:${req.caixa!.personId}`);
      void pollBotOutbox().catch(error=>app.log.error({err:error},'operator outbox wake failed'));
      return reply.code(202).send(result);
    });
  });
  app.post('/api/caixa/chat/conversations/:id/control',{preHandler:guards},async(req:Request,reply)=>{
    const p=params.safeParse(req.params),b=z.object({action:z.enum(['takeover','resume']),expected_version:z.number().int().min(0)}).strict().safeParse(req.body);
    if(!p.success||!b.success)return reply.code(400).send({error:'invalid_control'});
    return respond(reply,async()=>{await requireChatConversation(p.data.id);return changeBotConversationControl({
      conversationId:p.data.id,action:b.data.action,expectedVersion:b.data.expected_version,actor:`caixa:${req.caixa!.personId}`});});
  });
  app.get('/api/caixa/chat/conversations/:id/customer',{preHandler:guards},async(req,reply)=>{
    const p=params.safeParse(req.params);if(!p.success)return reply.code(400).send({error:'invalid_id'});
    const q=z.object({offset:z.coerce.number().int().min(0).max(10000).default(0)}).safeParse(req.query);
    if(!q.success)return reply.code(400).send({error:'invalid_query'});
    return respond(reply,async()=>{const c=await requireChatConversation(p.data.id);
      const [data,interests]=await Promise.all([
        c.contact_id?getCustomerDetail(env.FAREJADOR_ENV,'chatwoot',c.contact_id,{offset:q.data.offset}):null,
        q.data.offset===0?getOperationCustomerInterests(env.FAREJADOR_ENV,p.data.id):undefined,
      ]);
      reply.header('Cache-Control','private, no-store');
      return {...data,...(interests?{interests}:{})};});
  });
  app.get('/api/caixa/chat/conversations/:id/avatar',{preHandler:guards},async(req,reply)=>{
    const p=params.safeParse(req.params);if(!p.success)return reply.code(400).send({error:'invalid_id'});
    return respond(reply,async()=>{await requireChatConversation(p.data.id);return {url:await getCustomerLeadAvatar(p.data.id,env.FAREJADOR_ENV)};});
  });
  // Fetch streaming com Authorization: sem token na URL e nova autenticação a cada reconexão.
  app.get('/api/caixa/chat/stream',{preHandler:guards},async(req:Request,reply)=>{
    const release=acquirePartnerSseSlot(req.ip,`operator-chat:${req.caixa!.personId}`);
    if(!release)return reply.code(429).send({error:'too_many_connections'});
    reply.hijack();const raw=reply.raw;
    raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});
    raw.write(': connected\n\n');
    const unsubscribe=subscribeClientesKanban(env.FAREJADOR_ENV,event=>{
      void requireChatConversation(event.conversation_id).then(()=>{
        if(!raw.destroyed&&!raw.writableEnded)raw.write(`data: ${JSON.stringify({conversation_id:event.conversation_id,reason:event.reason})}\n\n`);
      }).catch(()=>{/* Conversas de outras contas não são expostas no stream. */});
    });
    const heartbeat=setInterval(()=>raw.write(': heartbeat\n\n'),10000);
    const expire=setTimeout(()=>raw.end(),60000);
    let closed=false;const close=()=>{if(closed)return;closed=true;clearInterval(heartbeat);clearTimeout(expire);unsubscribe();release();};
    raw.on('close',close);raw.on('error',close);
  });
}
