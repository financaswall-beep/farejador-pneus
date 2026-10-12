import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { mapProductToPartnerStock, type PartnerOrderRouting } from './fulfillment.js';
import type { StockConfirmationItem,StockConfirmationLocation } from './stock-confirmation-routing.js';

export interface StockRequest {
  id:string;environment:Environment;conversation_id:string;request_message_id:string|null;unit_id:string;
  status:string;items:Array<{tire_size:string;tire_condition:string|null;quantity:number;price:number}>;
  routing:{location:StockConfirmationLocation;items:StockConfirmationItem[];photoProductIds?:string[]};
  basket_key:string;revision:number;sealed:boolean;expires_at:Date;valid_until:Date|null;
  created_at:Date;
  closing_args:Record<string,unknown>|null;excluded_unit_ids:string[];notified_at:Date|null;
}
export function basketKey(items:StockConfirmationItem[]):string {
  const normalized=items.map(({product_id,quantity})=>({product_id,quantity})).sort((a,b)=>a.product_id.localeCompare(b.product_id));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
export function sameStockLocation(a:StockConfirmationLocation,b:StockConfirmationLocation):boolean {
  return a.municipio===b.municipio&&a.modalidade===b.modalidade
    &&a.clientNeighborhoodCanonical===b.clientNeighborhoodCanonical
    &&a.customerLocation?.lat===b.customerLocation?.lat&&a.customerLocation?.lng===b.customerLocation?.lng;
}
export async function lockStockConversation(client:PoolClient,environment:Environment,conversationId:string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`bot-order:${environment}:${conversationId}`]);
}
export async function latestStockRequest(client:PoolClient,environment:Environment,conversationId:string) {
  const result=await client.query<StockRequest>(`SELECT * FROM commerce.partner_stock_requests
    WHERE environment=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,[environment,conversationId]);
  return result.rows[0]??null;
}
export function requestConfirms(request:StockRequest|null,unitId:string,items:StockConfirmationItem[],now=Date.now()):boolean {
  return Boolean(request?.status==='confirmed' && request.unit_id===unitId && request.valid_until
    && new Date(request.valid_until).getTime()>now && items.length>0 && items.every(item=>item.quantity>0&&request.routing.items.some(
      confirmed=>confirmed.product_id===item.product_id && confirmed.quantity>=item.quantity)));
}
export async function requestPublicItems(client:PoolClient,environment:Environment,routing:PartnerOrderRouting) {
  const stock=await client.query<{id:string;tire_size:string;item_name:string;tire_condition:string|null;sale_price:string|null}>(
    `SELECT id,tire_size,item_name,tire_condition,sale_price::text FROM commerce.partner_stock_levels
      WHERE environment=$1 AND unit_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL`,
    [environment,routing.unitId,routing.items.map(item=>item.partner_stock_id)]);
  return routing.items.map(item=>{
    const row=stock.rows.find(s=>s.id===item.partner_stock_id);
    if(!row)throw new Error('confirmation_stock_changed');
    const price=row.sale_price==null?null:Number(row.sale_price);
    if(price==null||!Number.isFinite(price)||price<=0)throw new Error('partner_sale_price_missing');
    return {tire_size:row.tire_size||row.item_name,tire_condition:row.tire_condition,quantity:item.quantity,price};
  });
}
/** Uma resposta atrasada da loja não deve anunciar o preço anterior à edição. */
export async function refreshStockRequestPrices(client:PoolClient,request:StockRequest):Promise<boolean> {
  const updated=[];
  for(let i=0;i<request.routing.items.length;i++) {
    const item=request.routing.items[i]!,prior=request.items[i];
    const current=await mapProductToPartnerStock(client,request.environment,request.unit_id,item.product_id,item.quantity);
    if(!current||!prior)return false;
    updated.push({...prior,price:current.unit_price});
  }
  if(!updated.length)return false;
  if(updated.some((item,i)=>item.price!==request.items[i]!.price)) {
    await client.query('UPDATE commerce.partner_stock_requests SET items=$2::jsonb WHERE environment=$1 AND id=$3',
      [request.environment,JSON.stringify(updated),request.id]);
    request.items=updated;
  }
  return true;
}
export async function createStockRequest(client:PoolClient,environment:Environment,conversationId:string,
  messageId:string|null,location:StockConfirmationLocation,routing:PartnerOrderRouting,excluded:string[]=[],closingArgs:Record<string,unknown>|null=null) {
  const items=routing.items.map(({product_id,quantity})=>({product_id,quantity}));
  const prior=await latestStockRequest(client,environment,conversationId);
  const photoProductIds=(prior?.routing.photoProductIds??[]).filter(id=>items.some(item=>item.product_id===id));
  await client.query(`UPDATE commerce.partner_stock_requests SET status='cancelled'
    WHERE environment=$1 AND conversation_id=$2 AND status='pending'`,[environment,conversationId]);
  const result=await client.query<StockRequest>(`INSERT INTO commerce.partner_stock_requests
    (environment,conversation_id,request_message_id,unit_id,basket_key,items,routing,excluded_unit_ids,closing_args)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::uuid[],$9::jsonb) RETURNING *`,
    [environment,conversationId,messageId,routing.unitId,basketKey(items),JSON.stringify(await requestPublicItems(client,environment,routing)),
      JSON.stringify({location,items,photoProductIds}),excluded,closingArgs?JSON.stringify(closingArgs):null]);
  return result.rows[0]!;
}
export const STOCK_WAIT_TEXT='Estou confirmando esses pneus com a loja. Já te aviso assim que ela responder.';
