import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { syncHumanIntervention } from './conversation-control.js';
import { isAgentV2ConversationAllowed } from './conversation-scope.js';
import { enqueueAccessoryText } from './outbox-accessory.js';
import { executeTool } from './tools.js';
import { botOrderRequestId } from './order-attempt.js';
import { publishStockRequest } from './stock-confirmation.js';
import { createConfirmedStockPhotos } from './stock-confirmation-photo.js';
import { routeStockConfirmation } from './stock-confirmation-routing.js';
import { createStockRequest,latestStockRequest,lockStockConversation,type StockRequest } from './stock-confirmation-store.js';

const money=(value:unknown)=>Number(value||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
export function stockConfirmedText(request:StockRequest):string {
  const items=request.items.map(item=>`${item.quantity} × ${item.tire_size} — ${money(item.price)} cada`).join('\n');
  return `A loja confirmou esses pneus:\n${items}\nVocê prefere buscar ou receber?`;
}
export function confirmedOrderText(request:StockRequest,result:Record<string,unknown>):string {
  const pickup=result.retirada as {nome_loja?:string;endereco?:string;maps_url?:string}|undefined;
  const args=request.closing_args??{};
  const lines=[`✅ *Pedido:* ${result.order_number}`,`*Cliente:* ${String(args.nome_cliente??'')}`,
    ...request.items.map(item=>`• ${item.quantity} × ${item.tire_size}`),
    `*Total:* ${money(result.total)}`,`*Pagamento:* ${String(args.forma_pagamento??'')}`];
  if(pickup) {
    if(pickup.nome_loja)lines.push(`*Retirada:* ${pickup.nome_loja}`);
    if(pickup.endereco)lines.push(`*Endereço:* ${pickup.endereco}`);
    if(pickup.maps_url)lines.push(pickup.maps_url);
  } else if(args.modalidade==='delivery')lines.push(`*Entrega:* ${String(args.endereco_entrega??'')}`);
  return lines.join('\n');
}
async function notify(client:PoolClient,request:StockRequest,body:string) {
  const conversation=await client.query<{chatwoot_conversation_id:string}>(
    'SELECT chatwoot_conversation_id FROM core.conversations WHERE environment=$1 AND id=$2 AND deleted_at IS NULL',
    [request.environment,request.conversation_id]);
  const destination=conversation.rows[0]?.chatwoot_conversation_id;
  if(destination)await enqueueAccessoryText(client,{environment:request.environment,
    chatwootConversationId:Number(destination),kind:'stock_text',body,
    idempotencyKey:`stock:${request.id}:${request.revision}`});
  await client.query('UPDATE commerce.partner_stock_requests SET notified_at=now() WHERE id=$1',[request.id]);
}
async function handleRequest(client:PoolClient,request:StockRequest) {
  if((await latestStockRequest(client,request.environment,request.conversation_id))?.id!==request.id) {
    await client.query('UPDATE commerce.partner_stock_requests SET notified_at=now() WHERE id=$1',[request.id]);return;
  }
  const state=await syncHumanIntervention(client,request.environment,request.conversation_id);
  if(state.mode==='human'||(state.resumed_at&&new Date(request.created_at)<=new Date(state.resumed_at))
    ||!isAgentV2ConversationAllowed(env.AGENT_V2_CONVERSATION_IDS,request.conversation_id)) {
    await client.query("UPDATE commerce.partner_stock_requests SET status='cancelled',notified_at=now() WHERE id=$1",[request.id]);return;
  }
  if(request.status==='pending') {
    await client.query("UPDATE commerce.partner_stock_requests SET status='expired' WHERE id=$1",[request.id]);request.status='expired';
  }
  if(request.status==='confirmed') {
    if(!request.valid_until||new Date(request.valid_until).getTime()<=Date.now()) {
      await client.query("UPDATE commerce.partner_stock_requests SET status='expired' WHERE id=$1",[request.id]);request.status='expired';
    } else {
      let body=stockConfirmedText(request);
      const photos=await createConfirmedStockPhotos(client,request);
      if(photos)body=body.replace('Você prefere buscar ou receber?','Pedi as fotos para você conferir.');
      // Fechamento já autorizado pelo cliente: reaproveita validações e dedup originais.
      // Uma mensagem nova pode mudar a compra; nesse caso não fecha automaticamente.
      const latest=await botOrderRequestId(client,request.environment,request.conversation_id);
      if(!photos&&request.closing_args&&latest===request.request_message_id&&latest) {
        const result=JSON.parse(await executeTool(client,request.environment,request.conversation_id,
          'criar_pedido',request.closing_args,undefined,{triggerMessageId:latest})) as Record<string,unknown>;
        if(result.ok===true) {
          body=confirmedOrderText(request,result);
          await client.query("UPDATE commerce.partner_stock_requests SET status='completed' WHERE id=$1",[request.id]);
        } else if(result.aguardando_parceiro) {
          await publishStockRequest(client,request.environment,request.conversation_id);
          await client.query('UPDATE commerce.partner_stock_requests SET notified_at=now() WHERE id=$1',[request.id]);return;
        } else body='A loja respondeu, mas o pedido ainda não foi fechado. Vamos conferir os dados antes de continuar.';
      }
      await notify(client,request,body);return;
    }
  }
  // Não mistura lojas nem retorna ao parceiro que negou/deixou o prazo vencer.
  const excluded=[...new Set([...request.excluded_unit_ids,request.unit_id])];
  const next=await routeStockConfirmation(client,request.environment,request.routing.location,request.routing.items,excluded);
  await client.query('UPDATE commerce.partner_stock_requests SET notified_at=now() WHERE id=$1',[request.id]);
  if(next.kind==='partner') {
    const replacement=await createStockRequest(client,request.environment,request.conversation_id,
      request.request_message_id,request.routing.location,next.routing,excluded,request.closing_args);
    await publishStockRequest(client,request.environment,request.conversation_id);
    return;
  }
  const found=next.kind==='matriz'&&next.canFulfill&&!('blockReason' in next&&next.blockReason);
  await client.query('UPDATE commerce.partner_stock_requests SET status=$2,excluded_unit_ids=$3::uuid[],notified_at=NULL WHERE id=$1',
    [request.id,found?'matrix':'exhausted',excluded]);
  await notify(client,request,found
    ?'Essa loja não conseguiu confirmar. Encontrei disponibilidade na matriz. Quer que eu confira a opção para você?'
    :'As lojas que consultei não confirmaram esses pneus. Posso procurar outra opção para você?');
}
export async function processStockConfirmations():Promise<void> {
  if(!env.PARTNER_STOCK_CONFIRMATION||!env.BOT_OUTBOX)return;
  const candidates=await pool.query<Pick<StockRequest,'id'|'conversation_id'|'environment'>>(
    `SELECT id,conversation_id,environment FROM commerce.partner_stock_requests
      WHERE environment=$1 AND sealed AND notified_at IS NULL AND
        (status IN ('confirmed','rejected','expired') OR (status='pending' AND expires_at<=now()))
      ORDER BY updated_at,id LIMIT 30`,[env.FAREJADOR_ENV]);
  for(const candidate of candidates.rows) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await lockStockConversation(client,candidate.environment,candidate.conversation_id);
      const locked=await client.query<StockRequest>('SELECT * FROM commerce.partner_stock_requests WHERE id=$1 FOR UPDATE',[candidate.id]);
      const request=locked.rows[0];
      if(request&&request.notified_at===null&&['pending','confirmed','rejected','expired'].includes(request.status))await handleRequest(client,request);
      await client.query('COMMIT');
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>undefined);
      logger.error({err:error,requestId:candidate.id},'stock confirmation: processamento falhou; permanece para retry');
    } finally {client.release();}
  }
}
export function startStockConfirmationWorker():()=>void {
  if(!env.PARTNER_STOCK_CONFIRMATION||!env.BOT_OUTBOX||!env.AGENT_V2_WORKER_ENABLED)return ()=>undefined;
  let running=false;
  const tick=async()=>{if(running)return;running=true;try{await processStockConfirmations();}
    catch(err){logger.error({err},'stock confirmation: varredura falhou');}finally{running=false;}};
  const timer=setInterval(()=>void tick(),5000);void tick();
  return ()=>clearInterval(timer);
}
