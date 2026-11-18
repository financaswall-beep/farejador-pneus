import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { chaveEnderecoOferta } from './milly-termos.js';
import type { OfertaMilly } from './milly-negociacao.js';

interface Terms {
  unitId:string|null; paymentMethod:string|null; fulfillmentMode:string; freightCents:number;
  address:string|null; items:{product_id:string;quantidade:number;preco_unitario:number}[];
}
export function aplicarOfertaMilly(offer:OfertaMilly,terms:Terms) {
  if(!terms.items.some(item=>item.product_id===offer.productId))return {aplicavel:false as const};
  const item=terms.items[0];
  if(terms.unitId!==offer.unitId || terms.fulfillmentMode!==offer.fulfillmentMode ||
    terms.paymentMethod!==offer.paymentMethod || terms.freightCents!==offer.freightCents ||
    terms.items.length!==1 || !item || item.quantidade!==offer.quantity ||
    chaveEnderecoOferta(terms.address)!==offer.destinationKey) return {erro:'Os dados do pedido mudaram. Confira a condição correspondente e peça confirmação antes de fechar.'};
  const subtotal=offer.approvedTotalCents-offer.freightCents;
  if(!Number.isSafeInteger(subtotal)||subtotal<=0||subtotal%offer.quantity!==0) return {erro:'Oferta incompatível com o total do pedido. Confira a condição.'};
  if(Math.round(item.preco_unitario*100)!==subtotal/offer.quantity)return {
    erro:'O preço informado diverge da condição apresentada ao cliente. Confira o total da oferta e peça confirmação se houver divergência na conversa.'};
  return {aplicavel:true as const,items:[{...item,preco_unitario:subtotal/offer.quantity/100}]};
}
export interface FalaOferta {cliente:boolean;texto:string}
function normalizar(text:string) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
}
type CondicaoPublica=Pick<OfertaMilly,'approvedTotalCents'|'quantity'|'paymentMethod'|'fulfillmentMode'>;
const aceite=/^(sim|aceito|fechado|fechou|confirmo|quero sim|eu aceito|de acordo|combinado|pode (?:ser(?: assim)?|fechar|reservar|confirmar|fazer o pedido))\b/;
function confirmouTermos(texto:string,oferta:CondicaoPublica) {
  if(!aceite.test(texto))return false;
  let coerente=true;
  let resto=texto.replace(aceite,'').replace(/[.!👍✅]+$/gu,'');
  const valor=(_match:string,n:string)=>{
    const centavos=Math.round(Number(n.replace(/\./g,'').replace(',','.'))*100);
    if(!Number.isSafeInteger(centavos)||centavos!==oferta.approvedTotalCents)coerente=false;
    return ' ';
  };
  resto=resto.replace(/(?:r\$\s*|\bpor\s+)(\d+(?:\.\d{3})*(?:,\d{1,2})?)(?:\s*reais)?\b/g,valor)
    .replace(/\b(\d+(?:\.\d{3})*(?:,\d{1,2})?)\s*reais\b/g,valor);
  const quantidades:Record<string,number>={um:1,uma:1,dois:2,duas:2,tres:3,quatro:4};
  resto=resto.replace(/\b(\d+|um|uma|dois|duas|tres|quatro)\s+(?:pneus?|unidades?|un)\b/g,(_m,q:string)=>{
    if((quantidades[q]??Number(q))!==oferta.quantity)coerente=false;
    return ' ';
  });
  resto=resto.replace(/\b(pix|cartao|dinheiro)\b/g,(_m,p:string)=>{
    if(p!==oferta.paymentMethod)coerente=false;
    return ' ';
  }).replace(/\b(retirada|retirar|buscar|busco|entrega|entregue)\b/g,(_m,l:string)=>{
    if((l==='entrega'||l==='entregue'?'delivery':'pickup')!==oferta.fulfillmentMode)coerente=false;
    return ' ';
  });
  return coerente && !resto.replace(/\b(por|no|na|para|pra|com|a|o|de|da|do|eu|vou|pago|pagar|pagamento|em|e|total|reais|matriz)\b|[\s,.!:-]/g,'');
}
/** Autoriza só depois de aceite explícito. Uma ressalva ou novo assunto exige nova
 * confirmação. Dados de cadastro só preservam o aceite quando pedidos pela atendente. */
export function aceitouOferta(falas:FalaOferta[],oferta:CondicaoPublica):boolean {
  let aceitou=false,pediuCadastro=false,podeAceitar=true;
  for(const fala of falas) {
    const t=normalizar(fala.texto);
    if(!fala.cliente) {
      const precos=[...t.matchAll(/r\$\s*([0-9]+(?:\.[0-9]{3})*(?:,[0-9]{1,2})?)/g)];
      if(precos.some(m=>Math.round(Number(m[1]!.replace(/\./g,'').replace(',','.'))*100)!==oferta.approvedTotalCents))return false;
      pediuCadastro=/\b(nome|whats\w*|telefone|celular|ddd)\b/.test(t) && !/(?:r\$|\b(preco|valor|frete|condicao|pagamento|trocar)\b)/.test(t);
      podeAceitar=!pediuCadastro && /\b(fech\w*|confirm\w*|reserv\w*|aceit\w*|pode ser assim)\b/.test(t);
      if(!pediuCadastro)aceitou=false;
      continue;
    }
    if(!t||t.includes('?')||/\b(nao|mas|porem|so se|depende|menos|caro|desconto|cancela\w*|desist\w*|mudei|troca\w*)\b/.test(t)) {
      aceitou=false;pediuCadastro=false;podeAceitar=false;continue;
    }
    if(confirmouTermos(t,oferta)) {
      aceitou=podeAceitar;pediuCadastro=false;continue;
    }
    // Resposta livre a um pedido de cadastro pode conter nome e número; texto
    // com nova condição, preço ou modalidade nunca funciona como dado cadastral.
    if(!pediuCadastro||/(?:r\$|\b(pix|cartao|dinheiro|retirada|entrega|reais|levar|comprar|esperar|outro|outra|depois)\b)/.test(t)){
      aceitou=false;podeAceitar=false;
    }
    pediuCadastro=false;
  }
  return aceitou;
}
export async function clienteRespondeuAOferta(client:PoolClient,environment:Environment,
  conversationId:string,requestId:string|null,offer:OfertaMilly) {
  if(!requestId||requestId===offer.triggerMessageId||!offer.publishedProviderId)return false;
  return clienteAceitouDepois(client,environment,conversationId,requestId,offer.publishedProviderId,offer);
}
export async function clienteAceitouDepois(client:PoolClient,environment:Environment,conversationId:string,
  requestId:string|null,publishedProviderId:string,terms:CondicaoPublica) {
  if(!requestId)return false;
  // O relógio do Chatwoot tem precisão de segundos. O id de provedor ordena uma
  // confirmação imediatamente posterior no mesmo segundo sem arredondar o cutoff.
  const result=await client.query<{id:string;cliente:boolean;texto:string}>(`SELECT m.id,m.sender_type='contact' AS cliente,COALESCE(m.content,'') AS texto
    FROM core.messages m JOIN core.messages atual ON atual.environment=m.environment AND atual.conversation_id=m.conversation_id
      AND atual.id=$3 AND atual.sender_type='contact' AND atual.message_type=0 AND NOT atual.is_private AND atual.deleted_at IS NULL
    WHERE m.environment=$1 AND m.conversation_id=$2 AND NOT m.is_private AND m.deleted_at IS NULL
      AND ((m.sender_type='contact' AND m.message_type=0) OR (m.sender_type IN ('user','agent_bot') AND m.message_type=1))
      AND m.chatwoot_message_id>$4::bigint
      AND m.chatwoot_message_id<=atual.chatwoot_message_id
    ORDER BY m.chatwoot_message_id DESC LIMIT 25`,[environment,conversationId,requestId,publishedProviderId]);
  return result.rows.length<=24 && result.rows[0]?.id===requestId && aceitouOferta(result.rows.reverse(),terms);
}
