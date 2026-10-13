import type {PoolClient} from 'pg';
import type {Environment} from '../shared/types/chatwoot.js';
import {env} from '../shared/config/env.js';
import {logger} from '../shared/logger.js';
import {readWeeklyStoreHours,weeklyStoreHoursStatus} from '../shared/weekly-store-hours.js';
import {mapProductToPartnerStock} from './fulfillment.js';
import {latestStockRequest,type StockRequest} from './stock-confirmation-store.js';
import type {ChatMessage} from './types.js';

export interface ConfirmedStockFacts {
  requestId:string;storeId:string;storeName:string;location:unknown;priceChanged:boolean;
  items:Array<{productId:string;quantity:number;measure:string;price:number;confirmedPrice:number}>;
}
/** Confirmação operacional atual; não reaproveita preço, saldo ou horário do histórico. */
export async function loadConfirmedStockFacts(client:PoolClient,environment:Environment,
  request:StockRequest|null):Promise<ConfirmedStockFacts|null> {
  if(!env.PARTNER_STOCK_CONFIRMATION||request?.status!=='confirmed'
    ||!request.valid_until||!Number.isFinite(new Date(request.valid_until).getTime())||new Date(request.valid_until).getTime()<=Date.now()
    ||(request.environment&&request.environment!==environment)||!request.routing?.items?.length)return null;
  try {
    const store=(await client.query<{name:string;hours:unknown}>(`SELECT COALESCE(pu.display_name,u.name) name,
      to_jsonb(pu)->'opening_hours_weekly' hours FROM network.partner_units pu
      JOIN network.partners p ON p.id=pu.partner_id AND p.environment=pu.environment
      JOIN core.units u ON u.id=pu.unit_id AND u.environment=pu.environment
      WHERE pu.environment=$1 AND pu.unit_id=$2 AND pu.status='active' AND p.status='active'
        AND pu.accepts_network_orders AND pu.deleted_at IS NULL AND p.deleted_at IS NULL`,[environment,request.unit_id])).rows[0];
    if(!store||weeklyStoreHoursStatus(readWeeklyStoreHours(store.hours)).state!=='open')return null;
    const items:ConfirmedStockFacts['items']=[];
    for(const [index,item] of request.routing.items.entries()) {
      if(!item.product_id||!Number.isInteger(item.quantity)||item.quantity<=0)return null;
      const stock=await mapProductToPartnerStock(client,environment,request.unit_id,item.product_id,item.quantity);
      const snapshot=request.items[index];
      if(!stock||!snapshot||!Number.isFinite(stock.unit_price)||stock.unit_price<=0)return null;
      items.push({productId:item.product_id,quantity:item.quantity,measure:snapshot.tire_size,
        price:stock.unit_price,confirmedPrice:Number(snapshot.price)});
    }
    return {requestId:request.id,storeId:request.unit_id,storeName:store.name,
      location:request.routing.location,items,priceChanged:items.some(i=>Math.round(i.price*100)!==Math.round(i.confirmedPrice*100))};
  } catch(error){logger.warn({err:error,conversation_id:request.conversation_id},'confirmed stock context unavailable');return null;}
}
export function confirmedStockPrompt(facts:ConfirmedStockFacts|null):string {
  if(!facts)return '';
  return '\n[CONFIRMAÇÃO ATUAL DO PARCEIRO]\n'+JSON.stringify(facts)
    +'\nEstes dados foram revalidados pelo código neste turno. A loja já respondeu TENHO; não diga que ainda falta confirmação só porque uma busca antiga no histórico estava pendente.'
    +' Todos os itens acima foram confirmados na mesma loja. Para esclarecer loja/conjunto, localizacao_loja aceita todos os product_ids juntos; não escale por suposta impossibilidade de consultar dois pneus.'
    +' Para entrega use calcular_frete com todos os itens. Só feche por criar_pedido após autorização e dados necessários.'
    +' Se priceChanged=true, a loja alterou o preço depois da confirmação anterior: informe o novo valor e peça novo aceite, sem dizer que o preço anterior não foi confirmado. Se a mensagem atual já aceita explicitamente os valores novos informados, prossiga pelas ferramentas sem pedir o mesmo aceite de novo.'
    +' Esta confirmação cobre somente esses itens, quantidades e localização. Mudança de medida, quantidade ou região exige nova consulta; um resultado posterior da ferramenta prevalece sobre este bloco. Não significa pedido, reserva ou separação física.';
}
const fold=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const money=(value:number)=>value.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
/** Impede contradizer TENHO válido; não substitui as travas de fechamento/novo aceite. */
export function guardConfirmedStockReply(body:string,facts:ConfirmedStockFacts|null):string {
  if(!facts)return body;
  const text=fold(body);
  const denial=/loja (?:ainda )?nao confirmou (?:se (?:tem|ha)(?! (?:a |uma |as )?(?:foto|imagem|horario|entrega|instalacao))|(?:o |os |esse |esses )?(?:pneu|preco|estoque|disponibilidade))/.test(text)
    ||/nao (?:consigo|consegui|tenho) (?:a )?confirm(?:ar|acao).{0,100}(?:mesma loja|pneu|estoque|preco|disponibilidade)/s.test(text)
    ||(/sem (?:a )?confirmacao (?:da|de uma) loja/.test(text)&&(facts.priceChanged||/pneu|preco|estoque|disponibilidade/.test(text)));
  if(!denial)return body;
  const prices=facts.items.map(i=>`${i.quantity} × ${i.measure}: R$ ${money(i.price)} cada`).join('; ');
  return facts.priceChanged?`A loja alterou o preço: ${prices}. Confirma que quer seguir com esses valores?`
    :`A loja confirmou ${facts.items.length>1?'os pneus na mesma loja':'o pneu'}, na ${facts.storeName}: ${prices}.`;
}
export async function currentConfirmedStockPrompt(client:PoolClient,environment:Environment,request:StockRequest|null) {
  return confirmedStockPrompt(await loadConfirmedStockFacts(client,environment,request));
}
function hasNewerOrderOrStockDecision(actions:ChatMessage[]):boolean {
  const names=new Map(actions.flatMap(m=>(m.tool_calls??[]).map(call=>[call.id,call.function.name] as const)));
  const reads=new Set(['buscar_produto','buscar_compatibilidade','verificar_estoque','localizacao_loja','calcular_frete']);
  return actions.some(message=>{
    if(message.role!=='tool'||!message.tool_call_id)return false;
    try {
      const result=JSON.parse(message.content??'{}');const name=names.get(message.tool_call_id);
      return ((name==='criar_pedido'||name==='editar_pedido')&&result.ok===true)
        ||(reads.has(name??'')&&(result.erro||result.encontrado===false||result.disponivel===false
          ||result.sem_estoque_loja_perto||result.disponibilidade_confirmada===false));
    }catch{return false;}
  });
}
export async function guardCurrentConfirmedStockReply(client:PoolClient,environment:Environment,conversationId:string,body:string,actions:ChatMessage[]=[]) {
  if(hasNewerOrderOrStockDecision(actions))return body;
  if(!env.PARTNER_STOCK_CONFIRMATION)return body;
  return guardConfirmedStockReply(body,await loadConfirmedStockFacts(client,environment,await latestStockRequest(client,environment,conversationId)));
}
/** Devolve a confirmação ao modelo quando o único motivo de escalada é uma limitação inexistente. */
export async function correctConfirmedStockHandoff(client:PoolClient,environment:Environment,conversationId:string,
  args:Record<string,unknown>,customerText:string|null,actions:ChatMessage[]):Promise<string|null> {
  const reason=fold(String(args.resumo??''));
  if(!env.PARTNER_STOCK_CONFIRMATION||!['duvida_complexa','tool_falhou','outro'].includes(String(args.motivo))
    ||/\b(humano|atendente|gerente|pessoa)\b/.test(fold(customerText??''))
    ||!/mesma (?:loja|borracharia|unidade)/.test(reason)
    ||!/(?:nao.{0,100}(?:confirm|consult|verific)|sem.{0,40}(?:ferramenta|forma|meio).{0,80}(?:confirm|consult|verific)|impossiv.{0,80}(?:confirm|consult|verific))/.test(reason)
    ||hasNewerOrderOrStockDecision(actions))return null;
  const facts=await loadConfirmedStockFacts(client,environment,await latestStockRequest(client,environment,conversationId));
  if(!facts||facts.items.length<2)return null;
  return JSON.stringify({erro:'conjunto_ja_confirmado',confirmacao:facts,
    orientacao:'Não encaminhado: estes pneus já foram confirmados na mesma loja e revalidados agora. Prossiga pelas ferramentas com os dados e autorização do cliente. Preço alterado exige novo aceite; não invente pedido, frete ou reserva.'});
}
