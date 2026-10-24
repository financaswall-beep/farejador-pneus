import type { FastifyReply,FastifyRequest } from 'fastify';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import type { DotIdentity } from './token-store.js';
import { dotInstructions,invokeDotTool,listedDotTools } from './mcp-server.js';
import { eventDefinitions } from './events/model.js';
import { subscribe,unsubscribe } from './events/subscriptions.js';
import { dotEventsAvailable } from './events/availability.js';

const VERSION='2026-07-28';
const requestSchema=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number().int().safe()]),
  method:z.string(),params:z.object({_meta:z.object({
    'io.modelcontextprotocol/protocolVersion':z.string(),
    'io.modelcontextprotocol/clientInfo':z.object({name:z.string(),version:z.string()}).passthrough(),
    'io.modelcontextprotocol/clientCapabilities':z.record(z.unknown()),
  }).passthrough()}).passthrough()}).strict();
const emptyParams=z.object({cursor:z.string().optional()}).strict();
function decodedHeader(value:unknown) {
  if(typeof value!=='string')return value;
  const encoded=/^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/.exec(value);
  return encoded?Buffer.from(encoded[1]!,'base64').toString('utf8'):value;
}

/** Bounded stateless MCP 2.0 adapter. The installed v1 SDK continues serving legacy clients. */
export async function handleModernDot(request:FastifyRequest,reply:FastifyReply,identity:DotIdentity):Promise<boolean> {
  const body=request.body as {method?:unknown;params?:{_meta?:Record<string,unknown>}}|null;
  const version=body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  if(version===undefined&&request.headers['mcp-protocol-version']!==VERSION
    &&body?.method!=='server/discover'&&!(typeof body?.method==='string'&&body.method.startsWith('events/')))return false;
  const parsed=requestSchema.safeParse(body);
  const error=(status:number,code:number,message:string,id?:string|number,data?:unknown)=>{
    reply.code(status).send({jsonrpc:'2.0',...(id===undefined?{}:{id}),error:{code,message,...(data===undefined?{}:{data})}});return true;
  };
  if(!parsed.success)return error(400,-32600,'Requisição MCP 2.0 inválida');
  const {id,method,params}=parsed.data;
  if(version!==VERSION)return error(400,-32022,'Versão não suportada',id,{supported:[VERSION]});
  if(request.headers['mcp-protocol-version']!==version||request.headers['mcp-method']!==method
    ||(method==='tools/call'&&decodedHeader(request.headers['mcp-name'])!==params.name))
    return error(400,-32020,'Cabeçalhos MCP incompatíveis com o corpo',id);
  const {_meta,...args}=params;
  let result:object;
  try {
    if(method==='server/discover') {
      z.object({}).strict().parse(args);
      result={supportedVersions:[VERSION],capabilities:{tools:{},...(dotEventsAvailable()?{events:{}}:{})},
        instructions:dotInstructions(),ttlMs:0,cacheScope:'private',
        _meta:{'io.modelcontextprotocol/serverInfo':{name:'Farejador — Matriz',version:'1.3.0'}}};
    }else if(method==='tools/list'||method==='events/list') {
      const list=emptyParams.parse(args);
      if(list.cursor)throw new Error('invalid_cursor');
      if(method==='events/list'&&!dotEventsAvailable())return error(404,-32601,'Eventos indisponíveis',id);
      result={...(method==='tools/list'?{tools:listedDotTools()}:{events:eventDefinitions}),ttlMs:0,cacheScope:'private'};
    }else if(method==='tools/call') {
      const tool=z.object({name:z.string(),arguments:z.record(z.unknown()).optional()}).strict().parse(args);
      result=await invokeDotTool(identity,tool.name,tool.arguments);
    }else if(method==='events/subscribe'&&dotEventsAvailable())result=await subscribe(identity,args);
    else if(method==='events/unsubscribe'&&env.DOT_EVENTS_ENABLED)result=await unsubscribe(identity,args);
    else if(method==='ping'){z.object({}).strict().parse(args);result={};}
    else return error(404,-32601,'Método não disponível',id);
    reply.send({jsonrpc:'2.0',id,result:{resultType:'complete',...result}});return true;
  }catch(e) {
    if(e instanceof McpError)return error(200,e.code,e.message,id);
    if(e instanceof z.ZodError)return error(200,-32602,'Parâmetros inválidos',id);
    const reason=e instanceof Error?e.message:'';
    if(reason.startsWith('callback_')||reason==='invalid_callback')
      return error(200,-32015,'Não foi possível verificar o destino',id,{reason:'challenge_failed'});
    if(['invalid_signing_secret','subscription_limit','invalid_cursor'].includes(reason))return error(200,-32602,reason,id);
    return error(200,-32603,'Operação indisponível',id);
  }
}
