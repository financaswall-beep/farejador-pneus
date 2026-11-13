import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { rateLimitHit } from '../../shared/rate-limit.js';
import { dotConfig, DOT_MCP_PATH, DOT_SCOPE } from './config.js';
import { registerInstallmentReviews } from './route-installment-reviews.js';
import { registerDotOAuth } from './route-oauth.js';
import { validateDotAccess } from './token-store.js';
import { createDotMcpServer } from './mcp-server.js';
import { acquireDotRequest } from './request-limit.js';
import { handleModernDot } from './protocol-v2.js';
import { registerDotAlertSettings } from './events/route-settings.js';

export async function registerDotRoutes(fastify:FastifyInstance) {
  await registerDotAlertSettings(fastify);
  const config=dotConfig();
  if(!config)return;
  await fastify.register(async app=>{
    await registerDotOAuth(app,config);
    registerInstallmentReviews(app,config.origin);
    app.get('/admin/dot/consent.js',async(_request,reply)=>reply.type('text/javascript; charset=utf-8')
      .header('Cache-Control','no-store').send(await readFile('painel/public/dot-consent.js','utf8')));
    app.route({method:['GET','POST','DELETE'],url:DOT_MCP_PATH,bodyLimit:1450000,onRequest:async(request,reply)=>{
      const size=Number(request.headers['content-length']||0);
      if(size>16*1024 || request.headers['transfer-encoding']){
        const token=request.headers.authorization;
        if(typeof token!=='string'||!token.startsWith('Bearer ')||!await validateDotAccess(config,token.slice(7)))
          return reply.code(401).send({error:'invalid_token'});
      }
    },handler:async(request,reply)=>{
      reply.header('Cache-Control','no-store');
      const origin=request.headers.origin;
      if((origin&&origin!==config.origin)||request.headers.host!==new URL(config.origin).host) {
        return reply.code(403).send({error:'invalid_origin'});
      }
      if(rateLimitHit(`dot-mcp-ip:${request.ip}`,180,60_000))return reply.code(429).header('Retry-After','60').send({error:'too_many_requests'});
      const header=request.headers.authorization;
      const identity=await validateDotAccess(config,typeof header==='string'&&header.startsWith('Bearer ')?header.slice(7):'');
      if(!identity)return reply.code(401).header('WWW-Authenticate',
        `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/admin/dot/mcp", scope="${DOT_SCOPE}"`)
        .send({error:'invalid_token'});
      if(request.method!=='POST')return reply.code(405).header('Allow','POST').send({error:'method_not_allowed'});
      if(Array.isArray(request.body))return reply.code(400).send({error:'json_rpc_batch_not_supported'});
      if(rateLimitHit(`dot-mcp-grant:${identity.grant_id}`,60,60_000))return reply.code(429).header('Retry-After','60').send({error:'too_many_requests'});
      const body=request.body as {method?:string;params?:{name?:string}};
      if((Number(request.headers['content-length']||0)>16*1024 || request.headers['transfer-encoding'] && Buffer.byteLength(JSON.stringify(body))>16*1024)
        && !(body?.method==='tools/call' && ['anexar_comprovante_despesa','conferir_extrato_bancario'].includes(body.params?.name||'')))
        return reply.code(413).send({error:'body_too_large'});
      const release=acquireDotRequest(identity.grant_id);
      if(!release)return reply.code(429).header('Retry-After','2').send({error:'queries_busy'});
      try { if(await handleModernDot(request,reply,identity)){release();return reply;} }
      catch(error){release();throw error;}
      // A fresh server/transport per HTTP request avoids cross-user result/session reuse.
      const server=createDotMcpServer(identity);
      const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      try {
        await server.connect(transport);
        const headers=new Headers();
        for(const key of ['accept','content-type','mcp-protocol-version']) {
          const value=request.headers[key];if(typeof value==='string')headers.set(key,value);
        }
        const response=await transport.handleRequest(new Request(config.resource,{method:'POST',headers}),{parsedBody:request.body});
        return reply.code(response.status).type(response.headers.get('content-type')??'application/json').send(await response.text());
      }finally{try{await server.close();}finally{release();}}
    }});
  });
}
