import { chaveEnderecoOferta, money, nomeProdutoOferta } from './milly-termos.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { env } from '../shared/config/env.js';
import { loadCurrentCatalogPrices, moneyCents } from '../shared/catalog-pricing.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { confirmationLocation } from './stock-confirmation-routing.js';
import { stockConfirmationRouteOptions } from './stock-confirmation.js';
import { decideConfiguredStore } from './configured-routing.js';
import { decideStoreGeoOrFallback } from './delivery-quote-routing.js';
import { evaluateMatrizDelivery } from './matriz-delivery-eligibility.js';
import { resolveMatrizUnitId } from './fulfillment.js';
import { deliveryAddressHasNumber } from './previous-delivery-address.js';
import { buscarOfertaCheckoutMilly, solicitarConsultaMilly } from './milly-negociacao.js';
import type { ToolDefinition } from './types.js';

export const MILLY_PROMPT_VERSION = 'milly_closer_v1';
export const MILLY_RULES = `
[Negociação privada de varejo da Matriz, versão milly_closer_v1]
Use consultar_milly quando o cliente pedir uma exceção comercial para um pneu identificado: contraproposta, desconto por quantidade ou frete especial. Se só disser "caro", identifique se quer outra opção de catálogo ou negociar esta. Cumprimente e trate perguntas de localização, catálogo, frete normal, atendimento humano e atacado pelas regras normais. Interprete o histórico: uma mudança em quantidade, pagamento ou modalidade pode pedir nova avaliação. Nunca invente valores, aval, estoque ou entrega. Se faltar dado da venda, pergunte somente o que falta. Use o preço negociado apenas nas condições da oferta realmente apresentada. Aguarde a confirmação do cliente antes de criar o pedido. Preserve a privacidade das decisões internas.`;

const input = z.object({
  product_id:z.string().uuid(), quantidade:z.number().int().min(1).max(1000),
  modalidade:z.enum(['pickup','delivery']), forma_pagamento:z.enum(['pix','cartao','dinheiro']),
  total_proposto_centavos:z.number().int().positive().max(2147483647),
  bairro:z.string().trim().min(1).max(180).optional(), municipio:z.string().trim().min(1).max(150).optional(),
  endereco_entrega:z.string().trim().min(1).max(350).optional(),
}).strict();
export const MILLY_TOOL:ToolDefinition = {type:'function',function:{
  name:'consultar_milly',
  description:'Solicita uma condição especial de varejo para um pneu da Matriz. Informe o SKU buscado, quantidade, modalidade, pagamento e o total da proposta do cliente em centavos, incluindo o frete para entrega. Nunca invente a proposta. Para entrega use o endereço confirmado.',
  parameters:{type:'object',properties:{
    product_id:{type:'string'},quantidade:{type:'integer',minimum:1,maximum:1000},
    modalidade:{type:'string',enum:['pickup','delivery']},forma_pagamento:{type:'string',enum:['pix','cartao','dinheiro']},
    total_proposto_centavos:{type:'integer',minimum:1,maximum:2147483647},
    bairro:{type:'string'},municipio:{type:'string'},endereco_entrega:{type:'string'},
  },required:['product_id','quantidade','modalidade','forma_pagamento','total_proposto_centavos'],additionalProperties:false},
}};

export async function gatilhoTextoMilly(client:PoolClient,environment:Environment,conversationId:string,trigger:string) {
  const r=await client.query(`SELECT 1 FROM core.messages m WHERE m.environment=$1 AND m.conversation_id=$2
    AND m.id=$3 AND m.sender_type='contact' AND m.message_type=0 AND NOT m.is_private AND m.deleted_at IS NULL
    AND NULLIF(trim(m.content),'') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM core.message_attachments a WHERE a.environment=m.environment AND a.message_id=m.id)`,
  [environment,conversationId,trigger]);
  return r.rows.length>0;
}

export async function consultarMillyParaVenda(client:PoolClient,environment:Environment,conversationId:string,
  triggerMessageId:string,args:Record<string,unknown>) {
  const parsed=input.safeParse(args);
  if(!parsed.success)return {mensagem:'Confirme pneu, quantidade, proposta total, pagamento e modalidade antes de consultar.'};
  const a=parsed.data,items=[{product_id:a.product_id,quantity:a.quantidade}];
  if(a.modalidade==='delivery'&&!deliveryAddressHasNumber(a.endereco_entrega??'')) {
    return {mensagem:'Confirme o endereço com número para avaliar a exceção de entrega.'};
  }
  const location=await confirmationLocation(client,environment,conversationId,a);
  const routeOptions=await stockConfirmationRouteOptions(client,environment,conversationId,items);
  const unitId=await resolveMatrizUnitId(client,environment);
  if(!unitId || ('onlyUnitId' in routeOptions && routeOptions.onlyUnitId) || (!location.municipio&&!location.customerLocation)) {
    return {mensagem:'Confirme a localização e a loja responsável. Siga as condições verificadas dessa loja.'};
  }
  let freightCents=0;
  if(a.modalidade==='delivery') {
    const route=await decideStoreGeoOrFallback(client,environment,conversationId,{...routeOptions,items,municipio:location.municipio,
      bairro:a.bairro,fullAddress:a.endereco_entrega,modality:'delivery'});
    if(route.routing||route.onlyFar||route.blockReason||route.matrizFreight==null) {
      return {mensagem:'A entrega não foi confirmada pela Matriz. Siga a cotação da loja responsável.'};
    }
    freightCents=moneyCents(route.matrizFreight);
  } else if(env.PICKUP_TO_PARTNER&&env.ROUTING_GEO&&location.municipio&&location.customerLocation) {
    const route=await decideConfiguredStore(client,environment,{...location,...routeOptions,modalidade:'pickup',
      municipio:location.municipio,customerLocation:location.customerLocation,items});
    if(route.kind!=='matriz'||route.blockReason) return {mensagem:'Siga as condições verificadas da loja de retirada.'};
  }
  const [eligibility,catalog,name]=await Promise.all([
    evaluateMatrizDelivery(client,environment,{items,modalidade:a.modalidade,customerLocation:location.customerLocation}),
    loadCurrentCatalogPrices(client,environment,[a.product_id]),nomeProdutoOferta(client,environment,a.product_id),
  ]);
  const price=catalog.get(a.product_id);
  if(!eligibility.canFulfill||eligibility.block||!name||!price||price.currency!=='BRL') {
    return {mensagem:'Sem estoque ou preço de varejo confirmado para esta quantidade na Matriz. Consulte o catálogo.'};
  }
  const terms={environment,conversationId,triggerMessageId,unitId,productId:a.product_id,quantity:a.quantidade,
    paymentMethod:a.forma_pagamento,fulfillmentMode:a.modalidade,offeredTotalCents:a.total_proposto_centavos,
    catalogUnitCents:moneyCents(price.price_amount),freightCents,destinationKey:a.modalidade==='delivery'?chaveEnderecoOferta(a.endereco_entrega):null};
  if(terms.offeredTotalCents>=terms.catalogUnitCents*terms.quantity+freightCents) return {mensagem:'A condição de tabela já atende à proposta. Utilize o catálogo.'};
  const previous=await buscarOfertaCheckoutMilly(client,environment,conversationId,terms.productId);
  if(previous && previous.productId===terms.productId && previous.quantity===terms.quantity && previous.unitId===unitId &&
     previous.paymentMethod===terms.paymentMethod && previous.fulfillmentMode===terms.fulfillmentMode &&
     previous.destinationKey===terms.destinationKey && previous.freightCents===freightCents &&
     (previous.offeredTotalCents===terms.offeredTotalCents || previous.approvedTotalCents===terms.offeredTotalCents)) {
    return {mensagem:'Condição já apresentada e válida. Peça confirmação se o cliente ainda não aceitou.',
      total:money(previous.approvedTotalCents),modalidade:a.modalidade,pagamento:a.forma_pagamento};
  }
  const consulta=await solicitarConsultaMilly(client,terms);
  return consulta? {consulta}:{mensagem:'Consulta indisponível. Siga as condições oficiais do catálogo.'};
}
