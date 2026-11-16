import type { PoolClient } from 'pg';
import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { env } from '../../shared/config/env.js';
import { requirePublisher } from '../../marketing/publisher/config.js';
import { PublisherError } from '../../marketing/publisher/model.js';
import { beginIntegrityOperation, completeIntegrityOperation, operationFingerprint } from '../painel/stage5-integrity.js';
import { DOT_SCOPE } from './config.js';
import { transact } from './installment-reviews.js';
import type { DotIdentity } from './token-store.js';
import { withDotReadOnly } from './read-only.js';
import { attachmentInput, importAttachment, assertPublisherPermission } from './publisher-attachment.js';
import { prepareInput, preparePost, sendInput, sendPost, rescheduleInput, movePost,
  cancelInput, cancelPost, readInput, readPublisher } from './publisher-posts.js';

const catalog = new Map<string,{descriptor:Tool; run:(identity:DotIdentity,args:unknown)=>Promise<object>}>();
function describe(name:string, description:string, schema:z.ZodTypeAny, readOnly:boolean, external=false):Tool & {securitySchemes:{type:string;scopes:string[]}[]} {
  const {$schema,...input}=zodToJsonSchema(schema,{$refStrategy:'none'});
  const securitySchemes=[{type:'oauth2',scopes:[DOT_SCOPE]}];
  return {name,description,inputSchema:input as Tool['inputSchema'],
    annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:external,idempotentHint:true},
    securitySchemes,_meta:{securitySchemes,...(name==='importar_midia_publicacao'?{'openai/fileParams':['arquivo']}:{})}};
}
function write<S extends z.ZodTypeAny>(name:string, description:string, schema:S,
  execute:(db:PoolClient,data:z.output<S>,actor:string)=>Promise<object>,external=false) {
  catalog.set(name,{descriptor:describe(name,description+' Reutilize idempotency_key para repetir o mesmo pedido.',schema,false,external),
    run:(identity,args)=>transact(async db=>{
      await assertPublisherPermission(db,identity);
      const data=schema.parse(args);
      const operation={environment:env.FAREJADOR_ENV,domain:'dot.'+name,idempotencyKey:data.idempotency_key,
        fingerprint:operationFingerprint({grant:identity.grant_id,data})};
      const previous=await beginIntegrityOperation<object>(db,operation);
      if(previous.replayed) return previous.result;
      const result=await execute(db,data,'Milly · '+identity.person_id);
      await completeIntegrityOperation(db,operation,'network.dot_oauth_grants',identity.grant_id,result);
      return result;
    })});
}
const readName='consultar_publicador';
catalog.set(readName,{descriptor:describe(readName,'Consulte mídias prontas ou posts, versão, legenda, agendamento e resultado por rede. Envio em processamento não confirma publicação.',readInput,true),
  run:async(_identity,args)=>{requirePublisher();const data=readInput.parse(args??{});return withDotReadOnly(db=>readPublisher(db,data));}});
const importName='importar_midia_publicacao';
catalog.set(importName,{descriptor:describe(importName,'Importe uma foto ou vídeo anexado à conversa. Reutilize o UUID do pedido e o file_id em novas tentativas. Retorna media_id pronto para usar no post.',attachmentInput,false,true),run:importAttachment});
write('preparar_publicacao','Crie ou edite um rascunho com a legenda que você escreveu e as mídias na ordem pedida. Para pneus, forneça medida e condição confirmadas. O publicador inclui essas referências na legenda visível ao bot. Carrossel usa fotos no feed. Para vídeo use reel ou story.',prepareInput,preparePost);
write('publicar_ou_agendar_post','Somente a pedido do dono, publique agora (agendado_para=null) ou agende com data, hora e fuso. Use a versão do rascunho aprovado. Consulte o status por rede após o envio.',sendInput,sendPost,true);
write('reagendar_publicacao','Mude a data/hora de um post agendado a pedido do dono, antes do início do envio.',rescheduleInput,movePost,true);
write('cancelar_publicacao','Cancele um rascunho ou agendamento identificado pelo dono antes do início do envio.',cancelInput,cancelPost,true);
export const publisherTools=[...catalog.values()].map(t=>t.descriptor);
export function hasPublisherTool(name:string) {return catalog.has(name);}
export async function invokePublisherTool(identity:DotIdentity,name:string,args:unknown) {
  try {
    const data=await catalog.get(name)!.run(identity,args);
    return {structuredContent:{...data},content:[{type:'text' as const,text:JSON.stringify(data)}]};
  } catch(error) {
    if(error instanceof McpError) throw error;
    if(error instanceof z.ZodError) throw new McpError(ErrorCode.InvalidParams,'Confira os campos: '+error.issues.map(i=>i.path.join('.')||i.code).join(', '));
    const message=error instanceof Error?error.message:'';
    const code=error instanceof PublisherError?error.code:['idempotency_conflict','idempotency_incomplete','dot_grant_unavailable'].includes(message)?message:'publicador_indisponivel';
    return {isError:true,content:[{type:'text' as const,text:code}]};
  }
}
