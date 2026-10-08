// Ponte controlada no bootstrap: o parceiro não recebe permissões nas tabelas centrais.
import type { Pool } from 'pg';
import type { PartnerContext } from '../../parceiro/auth.js';
import { lockRequest, requestItems, requestTransaction } from './partner-wholesale-request-model.js';
import { settlePartnerArrivalOnClient } from './queries-partner-transfer-arrival.js';
import { receiveOperationPurchaseOnClient } from '../../parceiro/operation-purchase-receipt.js';
export async function receiveBuyRequest(ctx: PartnerContext, requestId: string,
  input: {idempotency_key:string;items:Array<{item_id:string;received_quantity:number}>}, dbPool?: Pool) {
  return requestTransaction(async client => {
    const request=await lockRequest(client,ctx.environment,requestId,ctx.partnerUnitId);
    if (request.unit_id!==ctx.unitId || request.partner_id!==ctx.partnerId) throw new Error('request_not_found');
    const items=await requestItems(client,ctx.environment,requestId);
    const normalized=input.items.map(i=>({item_id:i.item_id,received_quantity:i.received_quantity}))
      .sort((a,b)=>a.item_id.localeCompare(b.item_id));
    if (request.receipt_key) {
      if (request.receipt_key!==input.idempotency_key || JSON.stringify(request.receipt_items)!==JSON.stringify(normalized))
        throw new Error('idempotency_conflict');
      return {...request.receipt_result,idempotent:true};
    }
    if (request.status!=='dispatched' || !request.wholesale_order_id) throw new Error('request_state_conflict');
    if (normalized.length!==items.length || new Set(normalized.map(i=>i.item_id)).size!==items.length
      || items.some(i=>!normalized.some(n=>n.item_id===i.id))) throw new Error('request_items_mismatch');
    for (const item of items) {
      const quantity=normalized.find(i=>i.item_id===item.id)!.received_quantity;
      if (!Number.isInteger(quantity) || quantity<0 || quantity>item.quantity) throw new Error('receipt_quantity_invalid');
    }
    await client.query("SELECT set_config('app.partner_unit_id',$1,true)", [ctx.partnerUnitId]);
    const changed=(await client.query(`SELECT r.id FROM commerce.partner_wholesale_request_items r
      JOIN commerce.tire_specs ts ON ts.product_id=r.product_id AND ts.environment=r.environment
      WHERE r.request_id=$1 AND r.environment=$2 AND ts.vehicle_type IS NOT NULL AND ts.vehicle_type<>r.vehicle_type`,
      [requestId,ctx.environment])).rows;
    if (changed.length) throw new Error('request_product_changed');
    const order=(await client.query<{partner_transfer_status:string}>(`SELECT partner_transfer_status
      FROM commerce.wholesale_orders WHERE id=$1 AND environment=$2 FOR UPDATE`,
      [request.wholesale_order_id,ctx.environment])).rows[0];
    if (order?.partner_transfer_status==='in_transit') await settlePartnerArrivalOnClient(client,{
      environment:ctx.environment,order_id:request.wholesale_order_id,actor_label:`partner:${ctx.tokenId}`,
      idempotency_key:`partner-request:${request.id}:arrival:${input.idempotency_key}`,
      items:items.map(i=>({order_item_id:i.wholesale_order_item_id!,
        accepted_quantity:normalized.find(n=>n.item_id===i.id)!.received_quantity})),
    });
    else if (order?.partner_transfer_status!=='settled') throw new Error('request_state_conflict');
    const purchase=(await client.query<{id:string}>(`SELECT id FROM commerce.partner_purchases
      WHERE environment=$1 AND source_wholesale_order_id=$2 AND unit_id=$3 AND deleted_at IS NULL`,
      [ctx.environment,request.wholesale_order_id,ctx.unitId])).rows[0];
    if (!purchase) throw new Error('request_purchase_link_conflict');
    const purchaseItems=(await client.query<{id:string;source_wholesale_order_item_id:string}>(
      `SELECT id,source_wholesale_order_item_id FROM commerce.partner_purchase_items
       WHERE environment=$1 AND purchase_id=$2`, [ctx.environment,purchase.id])).rows;
    if (purchaseItems.length!==items.length) throw new Error('request_items_mismatch');
    const receipt=await receiveOperationPurchaseOnClient(client,ctx,'Recebimento pelo app',purchase.id,{
      idempotency_key:input.idempotency_key,items:items.map(i=>{
        const linked=purchaseItems.find(p=>p.source_wholesale_order_item_id===i.wholesale_order_item_id);
        if (!linked) throw new Error('request_purchase_link_conflict');
        return {item_id:linked.id,received_quantity:normalized.find(n=>n.item_id===i.id)!.received_quantity};
      }),
    },new Map(items.map(i=>{
      const linked=purchaseItems.find(p=>p.source_wholesale_order_item_id===i.wholesale_order_item_id);
      if (!linked) throw new Error('request_purchase_link_conflict');
      return [linked.id,{item_name:i.catalog_measure,tire_size:i.catalog_measure,brand:i.catalog_brand}];
    })));
    const result={...receipt,expected_units:items.reduce((sum,i)=>sum+i.quantity,0),
      has_divergence:items.some(i=>normalized.find(n=>n.item_id===i.id)!.received_quantity!==i.quantity)};
    await client.query(`UPDATE commerce.partner_wholesale_requests SET receipt_key=$3,receipt_items=$4::jsonb,
      receipt_result=$5::jsonb WHERE id=$1 AND environment=$2`,
      [request.id,ctx.environment,input.idempotency_key,JSON.stringify(normalized),JSON.stringify(result)]);
    return result;
  },dbPool);
}
