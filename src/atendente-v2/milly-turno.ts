import type { Pool, PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { notificarConsultaMilly } from '../admin/dot/events/negotiation-live.js';
import { cancelarConsultaMilly, consultaDoTurnoMilly, lerResultadoConsultaMilly } from './milly-negociacao.js';
import { nomeProdutoOferta, textoOfertaMilly } from './milly-termos.js';
import { lookupChatwootConversationId } from './history.js';
import { sendFinalAgentText } from './final-send.js';
import type { AgentV2JobInput } from './types.js';

export function orientacaoPublicaMilly(orientacao?:string) {
  if(orientacao==='oferecer_retirada')return '\nA entrega negociada não foi liberada. Ofereça avaliar retirada e aguarde a escolha do cliente. Não prometa um valor de retirada.';
  if(orientacao==='pedir_proposta')return '\nPergunte qual condição o cliente tem em mente. Não prometa desconto antes de um novo aval.';
  return '\nUse o valor vigente do catálogo. Uma alternativa de catálogo pode ser consultada se o cliente pedir.';
}

/** Uma notificação pode falhar depois que o Dot já registrou o aval. */
export async function notificarOuSeguir(pool:Pool,scope:Environment,id:string,conversa:string) {
  if(await notificarConsultaMilly(pool,scope,id,conversa).catch(()=>false))return true;
  await cancelarConsultaMilly(pool,scope,id);
  return (await lerResultadoConsultaMilly(pool,scope,id)).status==='approved';
}
/** A espera fica na fila, sem ocupar o worker, chamar a LLM ou carregar o histórico repetidamente. */
export async function retomarTurnoMilly(client:PoolClient,job:AgentV2JobInput) {
  const scope=job.environment as Environment;
  const q=await consultaDoTurnoMilly(client,scope,job.conversationId,job.triggerMessageId);
  if(!q)return 'novo';
  if(q.status==='pending')return {consultaMillyId:q.id};
  if(q.status==='approved' && q.approvedTotalCents && q.validUntil && new Date(q.validUntil).getTime()>Date.now()){
    const chatwootId=await lookupChatwootConversationId(client,job.conversationId);
    const name=await nomeProdutoOferta(client,scope,q.productId);
    if(chatwootId&&name) {
      const body=textoOfertaMilly({...q,approvedTotalCents:q.approvedTotalCents,validUntil:q.validUntil},name);
      await sendFinalAgentText(client,{jobId:job.jobId,conversationId:job.conversationId,
        triggerMessageId:job.triggerMessageId,environment:scope,chatwootConversationId:chatwootId,
        body,actions:[],millyOfferId:q.id,inputTokens:0,outputTokens:0,durationMs:0});
      return 'respondido';
    }
  }
  if(q.status==='declined')return {orientacao:orientacaoPublicaMilly(q.orientacao)};
  return 'tabela';
}
