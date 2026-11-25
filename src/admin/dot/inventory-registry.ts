import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { beginIntegrityOperation,completeIntegrityOperation,operationFingerprint,recordIntegrityEvent } from '../painel/stage5-integrity.js';
import { DOT_SCOPE } from './config.js';
import { lockGrant,readGrantPermission,transact } from './installment-reviews.js';
import { operationAllowed, requiresVoiceAuthorization, type OperationPermission } from './operation-policy.js';
import { requireOperationReview,markOperationExecuted,reviewFingerprint } from './operation-reviews.js';
import type { DotIdentity } from './token-store.js';

type PreparedWrite = {
  details: Record<string, unknown>;
  fingerprint: string;
  execute(db: PoolClient, actor: string, identity: DotIdentity): Promise<unknown>;
  matchesCompleted?(db: PoolClient, identity: DotIdentity, result: object): Promise<boolean>;
};
type WriteHandler<Data> = ((db: PoolClient, data: Data, actor: string, identity: DotIdentity) => Promise<unknown>) | {
  prepare(data: Data, run: (prepared: PreparedWrite) => Promise<unknown>): Promise<unknown>;
};

export const inventoryRegistry=new Map<string,{descriptor:Tool;run:(identity:DotIdentity,args:unknown)=>Promise<unknown>}>();
function descriptor(name:string,description:string,schema:z.ZodTypeAny,write:boolean,file=false):Tool & {securitySchemes:{type:string;scopes:string[]}[]} {
  const {$schema,...inputSchema}=zodToJsonSchema(schema,{$refStrategy:'none',effectStrategy:'input'});
  const securitySchemes=[{type:'oauth2',scopes:[DOT_SCOPE]}];
  return {name,description,inputSchema:inputSchema as Tool['inputSchema'],securitySchemes,
    _meta:{securitySchemes,...(file?{'openai/fileParams':['arquivo']}:{})},
    annotations:{readOnlyHint:!write,destructiveHint:write,idempotentHint:true,openWorldHint:file}};
}
export function registerInventoryRead<S extends z.ZodTypeAny>(name:string,description:string,schema:S,run:(data:z.output<S>)=>Promise<unknown>){
  registerConnectionRead(name,description,schema,data=>run(data));
}
export function registerConnectionRead<S extends z.ZodTypeAny>(name:string,description:string,schema:S,run:(data:z.output<S>,identity:DotIdentity)=>Promise<unknown>){
  inventoryRegistry.set(name,{descriptor:descriptor(name,description,schema,false),run:async(identity,args)=>run(schema.parse(args??{}),identity)});
}
export function registerInventoryWrite<S extends z.ZodTypeAny>(domain:'stock'|'catalog'|'retail'|'route'|'purchase_receipt',name:string,description:string,schema:S,
  handler:WriteHandler<z.output<S>>,file=false,
  preview?:(db:PoolClient,data:z.output<S>)=>Promise<object>, additionalDomain?:'retail'|'route'){
  let base:z.ZodTypeAny=schema;
  while(base instanceof z.ZodEffects)base=base.innerType();
  if(!(base instanceof z.ZodObject))throw Error('inventory_schema_requires_object');
  const keys=Object.keys(base.shape);
  const input=base.extend({idempotency_key:z.string().uuid()}).strict().superRefine((data,ctx)=>{
    const checked=schema.safeParse(Object.fromEntries(keys.filter(key=>key in data).map(key=>[key,data[key]])));
    if(!checked.success)for(const issue of checked.error.issues)ctx.addIssue(issue);
  });
  const authorization = requiresVoiceAuthorization(domain)
    ? ' Apresente a proposta e aguarde o dono autorizar diretamente por voz na conversa. Use confirmar_operacao_milly com canal_autorizacao=voz.'
    : ' Apresente a proposta e aguarde a autorização do dono. Em confirmacao=conversa use confirmar_operacao_milly após a resposta direta dele.';
  const checkPermission = (grant: OperationPermission) => {
    if (!operationAllowed(grant, domain)) throw Error('dot_'+domain+'_disabled');
    if (additionalDomain && !operationAllowed(grant, additionalDomain)) throw Error('dot_'+additionalDomain+'_disabled');
    return grant;
  };
  const runWrite = async (db: PoolClient, identity: DotIdentity, grant: OperationPermission,
    data: Record<string, unknown>, execute: (actor: string) => Promise<unknown>, prepared?: PreparedWrite) => {
    const key=z.string().uuid().parse(data.idempotency_key);
    const details=prepared?.details ?? (preview ? async()=>({...data,efeitos:await preview(db,data as z.output<S>)}) : data);
    const pending=await requireOperationReview(db,identity,name,key,details,grant,domain,prepared?.fingerprint);
    if(pending)return pending;
    const operation={environment:env.FAREJADOR_ENV,domain:'dot.'+name,idempotencyKey:key,
      fingerprint:operationFingerprint({grant:identity.grant_id,data:prepared?.fingerprint ?? reviewFingerprint(data)})};
    const matchesCompleted=prepared?.matchesCompleted;
    const previous=await beginIntegrityOperation<object>(db,operation,
      matchesCompleted && (result=>matchesCompleted(db,identity,result)));
    if(previous.replayed)return previous.result;
    const actor='Milly · '+identity.person_id;
    const result={status:'executada',executada:true,resultado:await execute(actor)};
    await recordIntegrityEvent(db,{environment:env.FAREJADOR_ENV,domain:'dot_'+domain,entityTable:'network.dot_oauth_grants',
      entityId:identity.grant_id,eventType:name,actorLabel:actor,idempotencyKey:key,
      after:{operation:key,confirmation:grant.operation_confirmation==='conversa'?'conversa':'painel'}});
    await completeIntegrityOperation(db,operation,'network.dot_oauth_grants',identity.grant_id,result);
    await markOperationExecuted(db,identity,name,key);
    return result;
  };
  inventoryRegistry.set(name,{descriptor:descriptor(name,description+authorization+' Reutilize idempotency_key nas tentativas do mesmo pedido.',input,true,file),
    run:async(identity,args)=>{
      const authorize=async(db:PoolClient)=>checkPermission(await lockGrant(db,identity.person_id,identity.grant_id));
      if (typeof handler === 'function') return transact(async db=>{
        const grant=await authorize(db);
        const data=input.parse(args);
        return runWrite(db,identity,grant,data,actor=>handler(db,data as z.output<S>,actor,identity));
      });
      // A preparação pode baixar um anexo. A trava da conexão só é tomada depois.
      checkPermission(await readGrantPermission(pool,identity.person_id,identity.grant_id));
      const data=input.parse(args);
      return handler.prepare(data as z.output<S>,prepared=>transact(async db=>{
        const grant=await authorize(db);
        return runWrite(db,identity,grant,data,actor=>prepared.execute(db,actor,identity),prepared);
      }));
    }});
}
export async function invokeInventoryTool(identity:DotIdentity,name:string,args:unknown){
  try{
    const result=await inventoryRegistry.get(name)!.run(identity,args);
    const data=result && typeof result==='object' && !Array.isArray(result)?result:{resultado:result};
    return {structuredContent:{...data},content:[{type:'text' as const,text:JSON.stringify(data)}]};
  }catch(error){
    if(error instanceof z.ZodError)throw new McpError(ErrorCode.InvalidParams,'Confira os campos: '+error.issues.map(i=>i.path.join('.')||i.code).join(', '));
    const message=error instanceof Error?error.message:'';
    const code=/^[a-z][a-z0-9_]{2,100}$/.test(message)?message:'operacao_indisponivel';
    return {isError:true,content:[{type:'text' as const,text:'Operação não concluída. '+code}]};
  }
}
