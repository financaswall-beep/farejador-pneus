import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractAdminSessionCookie, getAdminContext, requireAdminOwner } from '../auth.js';
import { validateMatrizAdminSession } from '../session.js';
import { env } from '../../shared/config/env.js';
import { rateLimitHit } from '../../shared/rate-limit.js';
import { dotPage } from './pages.js';
import { DOT_SCOPE, type DotConfig } from './config.js';
import { createDotConsent, consumeDotConsent } from './consent-store.js';
import { parseAuthorization, authorizationRedirect, dotTokenBody } from './oauth-validation.js';
import { exchangeDotToken, revokeDotToken, listDotConnections, revokeDotConnection } from './token-store.js';

export async function dotHumanOwner(request:FastifyRequest,reply:FastifyReply) {
  await requireAdminOwner(request,reply);
  if(reply.sent)return;
  if(getAdminContext(request).authType!=='session')return reply.code(403).send({error:'human_owner_required'});
}
async function pageOwner(request:FastifyRequest,reply:FastifyReply) {
  if(request.headers.authorization)return reply.code(403).send({error:'human_owner_required'});
  const session=extractAdminSessionCookie(request);
  const context=session?await validateMatrizAdminSession(env.FAREJADOR_ENV,session):null;
  if(!context)return reply.redirect('/admin/login?dot_return='+encodeURIComponent(request.url),303);
  if(context.role!=='owner')return reply.code(403).send({error:'owner_required'});
  return {context,session:session!};
}
export async function registerDotOAuth(app:FastifyInstance,config:DotConfig) {
  app.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string'},(_request,body,done)=>{
    const params=new URLSearchParams(String(body)),result:Record<string,string>={};
    for(const [key,value] of params){if(Object.hasOwn(result,key)){done(new Error('duplicate_oauth_parameter'));return;}result[key]=value;}
    done(null,result);
  });
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer')
      .header('X-Frame-Options','DENY');
    if(rateLimitHit(`dot-oauth:${request.ip}`,120,60_000))return reply.code(429).header('Retry-After','60').send({error:'too_many_requests'});
  });
  app.get('/.well-known/oauth-authorization-server',async()=>({issuer:config.origin,
    authorization_endpoint:config.origin+'/admin/dot/authorize',token_endpoint:config.origin+'/admin/dot/token',
    revocation_endpoint:config.origin+'/admin/dot/revoke',response_types_supported:['code'],
    grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],
    scopes_supported:[DOT_SCOPE],code_challenge_methods_supported:['S256'],authorization_response_iss_parameter_supported:true}));
  const metadata=async()=>({resource:config.resource,authorization_servers:[config.origin],
    scopes_supported:[DOT_SCOPE],bearer_methods_supported:['header'],resource_name:'Farejador — consultas da Matriz'});
  app.get('/.well-known/oauth-protected-resource/admin/dot/mcp',metadata);
  app.get('/.well-known/oauth-protected-resource',metadata);
  app.get('/admin/dot/authorize',async(request,reply)=>{
    const authorization=parseAuthorization(config,request.query);
    if(!authorization)return reply.code(400).send({error:'invalid_authorization_request'});
    const owner=await pageOwner(request,reply);
    if(reply.sent||!owner||!('context' in owner))return;
    const requestToken=await createDotConsent(owner.context,owner.session,authorization);
    return reply.type('text/html; charset=utf-8').send(dotPage(requestToken));
  });
  app.post('/admin/dot/authorize',{preHandler:dotHumanOwner},async(request,reply)=>{
    if(request.headers.origin!==config.origin)return reply.code(403).send({error:'csrf_rejected'});
    const parsed=z.object({request_token:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['allow','deny'])}).strict().safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_consent'});
    const result=await consumeDotConsent(getAdminContext(request),extractAdminSessionCookie(request)!,parsed.data.request_token,parsed.data.decision==='allow');
    if(!result||!parseAuthorization(config,result.authorization))return reply.code(400).send({error:'consent_expired'});
    return {redirect:authorizationRedirect(config,result.authorization,result.code?{code:result.code}:{error:'access_denied'})};
  });
  app.post('/admin/dot/token',async(request,reply)=>{
    const parsed=dotTokenBody.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_request'});
    const result=await exchangeDotToken(config,parsed.data);
    return result?reply.send(result):reply.code(400).send({error:'invalid_grant'});
  });
  app.post('/admin/dot/revoke',async(request,reply)=>{
    const parsed=z.object({client_id:z.literal(config.clientId),token:z.string().max(100),
      token_type_hint:z.enum(['access_token','refresh_token']).optional()}).strict().safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_request'});
    await revokeDotToken(config,parsed.data.token);
    return reply.send({});
  });
  app.get('/admin/dot/connections',async(request,reply)=>{
    await pageOwner(request,reply);
    if(reply.sent)return;
    return reply.type('text/html; charset=utf-8').send(dotPage());
  });
  app.get('/admin/api/dot/connections',{preHandler:dotHumanOwner},async request=>({connections:await listDotConnections(getAdminContext(request).personId!)}));
  app.post('/admin/api/dot/connections/:id/revoke',{preHandler:dotHumanOwner},async(request,reply)=>{
    if(request.headers.origin!==config.origin)return reply.code(403).send({error:'csrf_rejected'});
    const params=z.object({id:z.string().uuid()}).safeParse(request.params);
    if(!params.success)return reply.code(400).send({error:'invalid_connection'});
    await revokeDotConnection(getAdminContext(request).personId!,params.data.id);
    return {ok:true};
  });
}
