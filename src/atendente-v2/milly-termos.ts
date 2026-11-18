import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import type { OfertaMilly } from './milly-negociacao.js';

export function chaveEnderecoOferta(address:string|null|undefined):string|null {
  if (!address?.trim()) return null;
  const normalized=address.normalize('NFKC').toLocaleLowerCase('pt-BR').trim().replace(/\s+/g,' ');
  return createHash('sha256').update(normalized).digest('hex');
}
export const money=(n:number)=>(n/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
type PublicTerms = Pick<OfertaMilly,'quantity'|'paymentMethod'|'fulfillmentMode'|'approvedTotalCents'|'freightCents'|'validUntil'>;
export function textoOfertaMilly(offer:PublicTerms,productName:string):string {
  const pay={pix:'no Pix',cartao:'no cartão',dinheiro:'em dinheiro'}[offer.paymentMethod];
  const where=offer.fulfillmentMode==='pickup'?'para retirada na Matriz':'com entrega no endereço combinado';
  const until=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(offer.validUntil));
  return `Consigo fechar ${offer.quantity} un. de ${productName} por ${money(offer.approvedTotalCents)} no total, ${pay}, ${where}. Essa condição vale até ${until} (horário de Brasília). Pode ser assim?`;
}

export async function nomeProdutoOferta(client:PoolClient,environment:Environment,id:string):Promise<string|null> {
  const r=await client.query<{product_name:string}>(`SELECT product_name FROM commerce.products
    WHERE environment=$1 AND id=$2 AND product_type='tire' AND NOT partner_generic AND deleted_at IS NULL`,[environment,id]);
  return r.rows[0]?.product_name??null;
}
