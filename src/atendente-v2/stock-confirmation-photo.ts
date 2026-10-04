import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { env } from '../shared/config/env.js';
import { createPhotoRequest } from './photo-requests.js';
import { latestStockRequest,type StockRequest } from './stock-confirmation-store.js';

/** O cliente pede a foto uma vez. Ela segue para a loja que finalmente confirmar. */
export async function deferPhotoUntilStockConfirmed(client:PoolClient,environment:Environment,conversationId:string,productId:string) {
  if(!env.PARTNER_STOCK_CONFIRMATION)return null;
  const request=await latestStockRequest(client,environment,conversationId);
  if(request?.status!=='pending'||!request.routing.items.some(item=>item.product_id===productId))return null;
  const ids=[...new Set([...(request.routing.photoProductIds??[]),productId])];
  const saved=await client.query("UPDATE commerce.partner_stock_requests SET routing=jsonb_set(routing,'{photoProductIds}',$2::jsonb) WHERE id=$1 AND status='pending'",
    [request.id,JSON.stringify(ids)]);
  if(saved.rowCount!==1)return null;
  return JSON.stringify({status:'aguardando_parceiro',aguardando_parceiro:true,foto_solicitada:true,
    mensagem:'Primeiro a loja confirma os pneus; a foto já ficou solicitada. O cliente não precisa pedir de novo.'});
}
export async function createConfirmedStockPhotos(client:PoolClient,request:StockRequest):Promise<boolean> {
  if(!env.PHOTO_REQUESTS||!request.routing.photoProductIds?.length)return false;
  const conversation=await client.query<{chatwoot_conversation_id:string}>(
    'SELECT chatwoot_conversation_id FROM core.conversations WHERE environment=$1 AND id=$2',
    [request.environment,request.conversation_id]);
  const cw=conversation.rows[0]?.chatwoot_conversation_id;if(!cw)return false;
  const products=await client.query<{product_name:string;brand:string}>(
    'SELECT product_name,brand FROM commerce.products WHERE environment=$1 AND id=ANY($2::uuid[])',
    [request.environment,request.routing.photoProductIds]);
  let created=false;
  for(const product of products.rows) {
    const photo=await createPhotoRequest(client,request.environment,{unitId:request.unit_id,
      chatwootConversationId:Number(cw),tireSize:product.product_name,brand:product.brand});
    if(photo.status==='created'||photo.status==='dedup')created=true;
  }
  return created;
}
