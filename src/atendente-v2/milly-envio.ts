import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OutboundRow } from './outbound-worker.js';
import { consultaDoTurnoMilly, reservarEnvioOfertaMilly, confirmarEnvioOfertaMilly, reconciliarEcoOfertaMilly } from './milly-negociacao.js';
import { nomeProdutoOferta, textoOfertaMilly } from './milly-termos.js';
import { markOutboundAck } from './outbound-status.js';

export const OFERTA_INDISPONIVEL='No momento consigo seguir com o preço de tabela. Quer que eu confira as opções disponíveis nessa medida?';

/** O worker chama dentro da mesma transação que o envio externo e o ACK. */
export async function prepararSaidaOferta(client:PoolClient,row:OutboundRow):Promise<'confirmada'|'enviar'> {
  const id=row.milly_offer_id,trigger=row.trigger_message_id;
  if(!id||!trigger)throw Error('Oferta sem vínculo com o turno.');
  if(row.attempts>1) {
    await reconciliarEcoOfertaMilly(client,row.environment,row.conversation_id,id);
    const prior=await client.query<{provider:string}>(`SELECT published_provider_id::text AS provider
      FROM ops.milly_consultas WHERE environment=$1 AND conversation_id=$2 AND trigger_message_id=$3 AND id=$4
      AND state IN ('published','consumed') AND published_provider_id IS NOT NULL`,[row.environment,row.conversation_id,trigger,id]);
    if(prior.rows[0]) {
      await markOutboundAck(client,row,Number(prior.rows[0].provider));
      return 'confirmada';
    }
  }
  const q=await consultaDoTurnoMilly(client,row.environment,row.conversation_id,trigger);
  if(q?.id===id && q.status==='approved' && q.validUntil && q.approvedTotalCents) {
    const name=await nomeProdutoOferta(client,row.environment,q.productId);
    if(name && textoOfertaMilly({...q,validUntil:q.validUntil,approvedTotalCents:q.approvedTotalCents},name)===row.body &&
      await reservarEnvioOfertaMilly(client,row.environment,id,row.conversation_id,trigger,row.body)) return 'enviar';
  }
  row.body=OFERTA_INDISPONIVEL;
  row.milly_offer_id=null;
  await client.query(`UPDATE ops.outbound_messages SET body=$3,body_sha256=$4,milly_offer_id=NULL
    WHERE environment=$1 AND id=$2 AND status='sending'`,[row.environment,row.id,row.body,createHash('sha256').update(row.body).digest('hex')]);
  await client.query('UPDATE agent.turns SET say_text=$3 WHERE environment=$1 AND id=$2',[row.environment,row.turn_id,row.body]);
  return 'enviar';
}
export async function confirmarSaidaOferta(client:PoolClient,row:OutboundRow) {
  if(!await confirmarEnvioOfertaMilly(client,row.environment,row.milly_offer_id!,row.conversation_id,row.trigger_message_id!)) {
    throw Error('Não foi possível registrar o recebimento da oferta.');
  }
}
