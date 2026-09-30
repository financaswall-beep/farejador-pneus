import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner, getAdminContext } from '../auth.js';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { rateLimitHit } from '../../shared/rate-limit.js';
import { publisherConfig, requirePublisher, requireSending } from '../../marketing/publisher/config.js';
import { PublisherError, idSchema, draftSchema, uploadSchema, finalizeSchema } from '../../marketing/publisher/model.js';
import { listMedia, reserveMedia, finalizeMedia } from '../../marketing/publisher/media.js';
import { listPosts, saveDraft, submitPost, postAction } from '../../marketing/publisher/posts.js';
import { PublisherStorage } from '../../marketing/publisher/storage.js';
import { deleteMedia } from '../../marketing/publisher/cleanup.js';
import { PublisherGraph } from '../../marketing/publisher/graph.js';
import { generateCaption } from '../../marketing/publisher/caption.js';

const base='/admin/api/marketing/publisher';
const params=z.object({id:idSchema}).strict();
const submitSchema=z.object({version:z.number().int().min(1),scheduled_at:z.string().datetime({offset:true}).nullable()}).strict();
type Handler=(request:FastifyRequest)=>Promise<unknown>;
function guarded(handler:Handler,enabled=true) {
  return async(request:FastifyRequest,reply:FastifyReply)=>{
    reply.header('Cache-Control','no-store');
    try {if(enabled)requirePublisher();return await handler(request);}
    catch(error) {
      if(error instanceof z.ZodError)return reply.code(400).send({error:'invalid_publisher_request'});
      if(error instanceof PublisherError)return reply.code(error.status).send({error:error.code});
      // Erros de Storage/Graph não podem revelar tokens, URLs assinadas ou dados do operador.
      return reply.code(503).send({error:'publisher_unavailable'});
    }
  };
}
export async function registerMarketingPublisher(app:FastifyInstance):Promise<void> {
  const options={preHandler:requireAdminOwner};const environment=env.FAREJADOR_ENV;
  app.get(base,options,guarded(async()=>{
    const config=publisherConfig();
    const schema=await pool.query<{ready:boolean}>(`SELECT to_regclass('ops.publisher_posts') IS NOT NULL ready`);
    const ready=schema.rows[0]?.ready===true;
    return {config:{...config,schema_ready:ready},
      posts:config.enabled&&ready?await listPosts(pool,environment):[],
      media:config.enabled&&ready&&config.storage_ready?await listMedia(pool,environment):[]};
  },false));
  app.post(base+'/connections',options,guarded(async()=>({connections:await new PublisherGraph().connections()})));
  app.post(base+'/media',options,guarded(async request=>{
    return reserveMedia(pool,environment,uploadSchema.parse(request.body),getAdminContext(request).displayName);
  }));
  app.post(base+'/media/:id/complete',{...options,bodyLimit:400000},guarded(async request=>{
    return finalizeMedia(pool,environment,params.parse(request.params).id,finalizeSchema.parse(request.body));
  }));
  app.post(base+'/media/:id/preview',options,guarded(async request=>{
    const id=params.parse(request.params).id;
    const media=(await pool.query<{original_path:string}>(`SELECT original_path FROM ops.publisher_media
      WHERE environment=$1 AND id=$2 AND status='ready'`,[environment,id])).rows[0];
    if(!media)throw new PublisherError('publisher_media_not_found',404);
    return {url:await new PublisherStorage().signedUrl(media.original_path,900)};
  }));
  app.post(base+'/media/:id/remove',options,guarded(async request=>{
    await deleteMedia(pool,environment,params.parse(request.params).id,false);return {removed:true};
  }));
  app.put(base+'/posts/:id',options,guarded(async request=>{
    return saveDraft(pool,environment,params.parse(request.params).id,draftSchema.parse(request.body),getAdminContext(request).displayName);
  }));
  app.post(base+'/posts/:id/submit',options,guarded(async request=>{
    requireSending();const body=submitSchema.parse(request.body);
    return submitPost(pool,environment,params.parse(request.params).id,body.version,body.scheduled_at,getAdminContext(request).displayName);
  }));
  app.post(base+'/posts/:id/action',options,guarded(async request=>{
    const body=z.object({action:z.enum(['cancel','retry'])}).strict().parse(request.body);
    if(body.action==='retry')requireSending();
    return postAction(pool,environment,params.parse(request.params).id,body.action,getAdminContext(request).displayName);
  }));
  app.post(base+'/caption',options,guarded(async request=>{
    const body=z.object({brief:z.string().trim().min(5).max(1200)}).strict().parse(request.body);
    const actor=getAdminContext(request);
    if(rateLimitHit(`publisher-caption:${actor.personId??request.ip}`,10,3600000))throw new PublisherError('publisher_ai_rate_limit',429);
    return generateCaption(pool,environment,body.brief);
  }));
}
