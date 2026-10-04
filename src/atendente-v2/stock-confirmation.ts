import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { env } from '../shared/config/env.js';
import type { PartnerOrderRouting } from './fulfillment.js';
import { botOrderRequestId } from './order-attempt.js';
import { confirmationLocation,routeStockConfirmation,type StockConfirmationItem } from './stock-confirmation-routing.js';
import { basketKey,createStockRequest,latestStockRequest,lockStockConversation,requestConfirms,sameStockLocation,STOCK_WAIT_TEXT } from './stock-confirmation-store.js';

type Product=Record<string,unknown>;
export function selectedConfirmationProducts(result:Record<string,unknown>):Product[] {
  const products:Product[]=[];
  if(Array.isArray(result.produtos))products.push(...result.produtos);
  if(Array.isArray(result.veiculos))for(const vehicle of result.veiculos) {
    if(Array.isArray(vehicle.produtos))products.push(...vehicle.produtos);
  }
  const measures=new Set<string>();
  return products.filter(product=>{
    const quantity=Number(product.total_stock_available??product.total_stock??0);
    const measure=String(product.tire_size??product.product_id??'');
    if(!product.product_id||quantity<=0||measures.has(measure))return false;
    measures.add(measure);return true;
  });
}
const waitingResult=(id:string)=>JSON.stringify({encontrado:true,disponibilidade_confirmada:false,
  aguardando_parceiro:true,solicitacao_id:id,mensagem:STOCK_WAIT_TEXT,
  orientacao:'Aguarde a resposta da loja. Não diga que tem, não prometa reserva, não feche pedido nem peça os mesmos dados novamente.'});

/** Busca continua determinística. Só a promessa do estoque do parceiro aguarda confirmação. */
export async function gatePartnerSearch(client:PoolClient,environment:Environment,conversationId:string,
  name:string,args:Record<string,unknown>,raw:string):Promise<string> {
  if(!env.PARTNER_STOCK_CONFIRMATION||!['buscar_produto','buscar_compatibilidade','verificar_estoque','localizacao_loja'].includes(name))return raw;
  const result=JSON.parse(raw) as Record<string,unknown>;
  if(result.erro||result.precisa_localizacao||result.aguardando_parceiro||result.encontrado===false||result.disponivel===false)return raw;
  const requestedQuantity=Number.isInteger(args.quantidade)&&Number(args.quantidade)>0&&Number(args.quantidade)<=20?Number(args.quantidade):1;
  let items=selectedConfirmationProducts(result).map(product=>({product_id:String(product.product_id),quantity:requestedQuantity}));
  if(!items.length&&['verificar_estoque','localizacao_loja'].includes(name)) {
    const ids=Array.isArray(args.product_ids)?args.product_ids:args.product_id?[args.product_id]:[];
    items=ids.filter((id):id is string=>typeof id==='string').map(product_id=>({product_id,quantity:requestedQuantity}));
  }
  // Localização/checagem não cria outra pergunta; o criar_pedido também tem trava própria.
  if(!items.length)return raw;
  const location=await confirmationLocation(client,environment,conversationId,args);
  if(!location.municipio&&!location.customerLocation)return raw;
  await client.query('BEGIN');
  try {
    await lockStockConversation(client,environment,conversationId);
    const prior=await latestStockRequest(client,environment,conversationId);
    const messageId=await botOrderRequestId(client,environment,conversationId);
    if(prior?.status==='pending'&&!prior.sealed&&prior.request_message_id===messageId) {
      const merged=new Map(prior.routing.items.map(item=>[item.product_id,item]));
      items.forEach(item=>merged.set(item.product_id,item));items=[...merged.values()];
    }
    const sameLocation=prior&&sameStockLocation(prior.routing.location,location);
    const stale=prior&&(prior.status==='rejected'||prior.status==='expired'
      ||(prior.status==='pending'&&new Date(prior.expires_at).getTime()<=Date.now()));
    const excluded=sameLocation?[...new Set([...prior.excluded_unit_ids,...(stale?[prior.unit_id]:[])])]:[];
    const decision=await routeStockConfirmation(client,environment,location,items,excluded,
      sameLocation&&prior?.status==='confirmed'?prior.unit_id:undefined);
    if(decision.kind!=='partner') {
      if(prior?.status==='pending')await client.query("UPDATE commerce.partner_stock_requests SET status='cancelled' WHERE id=$1",[prior.id]);
      await client.query('COMMIT');
      if(items.length>1&&prior?.status==='pending'&&decision.kind==='matriz'&&!decision.canFulfill)return JSON.stringify({
        encontrado:false,conjunto_nao_confirmado:true,mensagem:'Não foi encontrada loja que confirme o conjunto completo. Não divida entre lojas nem prometa os dois pneus.'});
      return raw;
    }
    if(sameLocation&&requestConfirms(prior,decision.routing.unitId,items)) {
      await client.query('COMMIT');
      const filter=(products:Product[])=>products.filter(product=>items.some(item=>item.product_id===product.product_id)).map(product=>{
        const quantity=prior!.routing.items.find(item=>item.product_id===product.product_id)!.quantity;
        return {...product,...('total_stock_available' in product?{total_stock_available:quantity}:{}),...('total_stock' in product?{total_stock:quantity}:{})};
      });
      return JSON.stringify({...result,...(Array.isArray(result.produtos)?{produtos:filter(result.produtos)}:{}),
        ...(Array.isArray(result.veiculos)?{veiculos:result.veiculos.map(vehicle=>({...vehicle,produtos:filter(vehicle.produtos??[])}))}:{}),disponibilidade_confirmada:true,
        produtos_confirmados:items.map(item=>item.product_id)});
    }
    if(prior?.status==='pending'&&prior.unit_id===decision.routing.unitId&&sameLocation
      &&prior.basket_key===basketKey(items)&&new Date(prior.expires_at).getTime()>Date.now()) {
      await client.query('COMMIT');return waitingResult(prior.id);
    }
    const request=await createStockRequest(client,environment,conversationId,messageId,location,decision.routing,excluded);
    await client.query('COMMIT');return waitingResult(request.id);
  } catch(error) { await client.query('ROLLBACK');throw error; }
}
export async function requirePartnerStockConfirmation(client:PoolClient,environment:Environment,conversationId:string,
  routing:PartnerOrderRouting,args:Record<string,unknown>,messageId:string|null):Promise<string|null> {
  if(!env.PARTNER_STOCK_CONFIRMATION)return null;
  const prior=await latestStockRequest(client,environment,conversationId);
  const items=routing.items.map(({product_id,quantity})=>({product_id,quantity}));
  if(requestConfirms(prior,routing.unitId,items))return null;
  if(prior?.status==='pending'&&prior.unit_id===routing.unitId&&new Date(prior.expires_at).getTime()>Date.now()
    &&prior.basket_key===basketKey(items)) {
    await client.query('UPDATE commerce.partner_stock_requests SET closing_args=$2::jsonb,request_message_id=$3 WHERE id=$1',
      [prior.id,JSON.stringify(args),messageId]);
    return waitingResult(prior.id);
  }
  const location=await confirmationLocation(client,environment,conversationId,args);
  const request=await createStockRequest(client,environment,conversationId,messageId,location,routing,[],args);
  return waitingResult(request.id);
}
/** Dá preferência à loja que já respondeu, sem furar cobertura, distância nem estoque. */
export async function stockConfirmationRouteOptions(client:PoolClient,environment:Environment,conversationId:string,items:StockConfirmationItem[]) {
  if(!env.PARTNER_STOCK_CONFIRMATION)return {};
  const request=await latestStockRequest(client,environment,conversationId);
  if(!request)return {};
  const covers=items.every(item=>request.routing.items.some(i=>i.product_id===item.product_id&&i.quantity>=item.quantity));
  const stale=request.status==='rejected'||request.status==='expired'
    ||(request.status==='pending'&&new Date(request.expires_at).getTime()<=Date.now());
  return covers?{excludedUnitIds:[...new Set([...request.excluded_unit_ids,...(stale?[request.unit_id]:[])])],
    ...(requestConfirms(request,request.unit_id,items)?{onlyUnitId:request.unit_id}:{})}:{};
}
export async function sealStockRequestAndGuardText(client:PoolClient,environment:Environment,conversationId:string,body:string) {
  if(!env.PARTNER_STOCK_CONFIRMATION)return body;
  const request=await latestStockRequest(client,environment,conversationId);
  return request?.status==='pending'?STOCK_WAIT_TEXT:body;
}
export async function publishStockRequest(client:PoolClient,environment:Environment,conversationId:string) {
  if(!env.PARTNER_STOCK_CONFIRMATION)return;
  const published=await client.query<{id:string;unit_id:string}>(`UPDATE commerce.partner_stock_requests SET sealed=true
    WHERE environment=$1 AND conversation_id=$2 AND status='pending' AND NOT sealed RETURNING id,unit_id`,[environment,conversationId]);
  for(const request of published.rows)await client.query("SELECT pg_notify('partner_chat',$1)",
    [JSON.stringify({unit_id:request.unit_id,conversation_id:'',kind:'stock_confirmation',request_id:request.id})]);
}
export async function cancelStockConfirmation(client:PoolClient,environment:Environment,conversationId:string) {
  if(env.PARTNER_STOCK_CONFIRMATION)await client.query(`UPDATE commerce.partner_stock_requests
    SET status='cancelled' WHERE environment=$1 AND conversation_id=$2 AND status IN ('pending','confirmed')`,[environment,conversationId]);
  return JSON.stringify({ok:true,mensagem:'Consulta à loja cancelada. Não foi criado pedido nem reserva.'});
}
export const CANCEL_STOCK_CONFIRMATION_TOOL={type:'function' as const,function:{name:'cancelar_consulta_estoque',
  description:'Cancela a consulta pendente ao parceiro quando o cliente desistir antes de criar um pedido. Não cancela uma venda já criada.',
  parameters:{type:'object',properties:{},additionalProperties:false}}};
