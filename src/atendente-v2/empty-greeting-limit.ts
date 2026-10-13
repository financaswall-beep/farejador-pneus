import type {PoolClient} from 'pg';
import type {AgentV2JobInput,ChatMessage} from './types.js';
import {requestHumanHandoff} from './human-handoff.js';

export function isEmptyGreeting(text:string|null|undefined):boolean {
  const normalized=String(text??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[\p{P}\p{S}]/gu,' ').replace(/\s+/g,' ').trim();
  return /^(?:(?:oi|ola|opa|e ai|bom dia|boa tarde|boa noite|tudo bem|tudo bom|tudo certo|beleza|blz|como vai)(?:\s+|$))+$/.test(normalized);
}
export function hasRepeatedEmptyGreetings(history:ChatMessage[]):boolean {
  let consecutive=0;
  for(const message of [...history].reverse()) {
    if(message.role!=='user')continue;
    if(!isEmptyGreeting(message.content))return false;
    if(++consecutive>=3)return true;
  }
  return false;
}
export async function handoffEmptyGreetings(client:PoolClient,job:AgentV2JobInput,chatwootConversationId:number,durationMs:number) {
  const environment=job.environment;
  if(environment!=='test'&&environment!=='prod')throw Error('greeting_handoff_invalid_environment');
  const args={motivo:'outro',resumo:'Três cumprimentos consecutivos sem pedido ou informação. Encaminhar para atendente e evitar repetição automática.'};
  const callId=`greeting-limit:${job.jobId}`;
  const result=JSON.parse(await requestHumanHandoff(client,args,{toolCallId:callId,input:{...job,environment,chatwootConversationId,
    durationMs,inputTokens:0,outputTokens:0,actions:[{role:'assistant',content:null,
      tool_calls:[{id:callId,type:'function',function:{name:'escalar_humano',arguments:JSON.stringify(args)}}]}]}}));
  if(!['sent','shadowed','superseded'].includes(result.status))throw Error('human_handoff_not_completed');
}
