import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { recordIntegrityEvent } from './stage5-integrity.js';
import { registerWholesaleSaleOnClient } from './queries-atacado-vendas.js';
import { resolveWholesaleBuyer } from './queries-atacado-sale-buyer.js';
import { resolveWholesalePartnerUnit } from './wholesale-partner-bridge.js';
import { changeRequestReservation, lockRequest, requestItems, requestTransaction,
  type RequestEnvironment } from './partner-wholesale-request-model.js';
export { listWholesaleRequests } from './partner-wholesale-request-model.js';

export async function decideWholesaleRequest(input: { id: string; environment: RequestEnvironment;
  actor: string; action: 'approve' | 'reject' | 'dispatch'; reason?: string; due_date?: string }, dbPool?: Pool) {
  if (!env.WHOLESALE_FINANCE && input.action!=='reject') throw new Error('wholesale_finance_required');
  return requestTransaction(async client => {
    const request = await lockRequest(client,input.environment,input.id,undefined,input.action!=='reject');
    const items = await requestItems(client,input.environment,input.id);
    if (input.action==='approve') {
      if (request.status==='approved') return {request_id:request.id,status:request.status,idempotent:true};
      if (request.status!=='requested') throw new Error('request_state_conflict');
      // O escritor de preços usa a mesma trava de produto. O catálogo é relido depois da trava.
      await client.query(`SELECT id FROM commerce.products WHERE environment=$1 AND id=ANY($2::uuid[])
        ORDER BY id FOR UPDATE`, [input.environment,items.map(i=>i.product_id)]);
      for (const item of items) await client.query(`SELECT measure FROM commerce.wholesale_stock
        WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4 FOR UPDATE`,
        [input.environment,item.measure,item.brand,item.tire_condition]);
      await client.query("SELECT set_config('app.partner_unit_id',$1,true)", [request.partner_unit_id]);
      const offers = (await client.query<{offer_key:string;price_cents:string;quantity_available:number;vehicle_type:string}>(
        'SELECT * FROM commerce.partner_wholesale_catalog()')).rows;
      for (const item of items) {
        const offer=offers.find(o=>o.offer_key===item.product_id);
        if (!offer || offer.vehicle_type!==item.vehicle_type) throw new Error('offer_changed');
        if (Number(offer.price_cents)!==Number(item.unit_price_cents)) throw new Error('price_changed');
        if (offer.quantity_available<item.quantity) throw new Error('stock_changed');
      }
      await changeRequestReservation(client,request,items,1);
      await client.query(`UPDATE commerce.partner_wholesale_requests SET status='approved',approved_at=now(),approved_by=$3
        WHERE id=$1 AND environment=$2`, [request.id,input.environment,input.actor]);
    } else if (input.action==='reject') {
      if (!input.reason?.trim()) throw new Error('reason_required');
      if (request.status==='rejected') {
        if (request.rejection_reason!==input.reason.trim()) throw new Error('idempotency_conflict');
        return {request_id:request.id,status:request.status,idempotent:true};
      }
      if (!['requested','approved'].includes(request.status)) throw new Error('request_state_conflict');
      if (request.status==='approved') await changeRequestReservation(client,request,items,-1);
      await client.query(`UPDATE commerce.partner_wholesale_requests SET status='rejected',rejected_at=now(),rejected_by=$3,
        rejection_reason=$4 WHERE id=$1 AND environment=$2`, [request.id,input.environment,input.actor,input.reason.trim()]);
    } else {
      if (request.status==='dispatched') {
        const order=(await client.query<{due_date:string}>(`SELECT due_date::text FROM commerce.wholesale_orders
          WHERE id=$1 AND environment=$2`, [request.wholesale_order_id,input.environment])).rows[0];
        if (order?.due_date!==input.due_date) throw new Error('idempotency_conflict');
        return {request_id:request.id,status:request.status,order_id:request.wholesale_order_id,idempotent:true};
      }
      if (request.status!=='approved') throw new Error('request_state_conflict');
      if (!input.due_date) throw new Error('due_date_required');
      const parsedDate=new Date(input.due_date+'T12:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.due_date) || !Number.isFinite(parsedDate.getTime())
        || parsedDate.toISOString().slice(0,10)!==input.due_date) throw new Error('due_date_invalid');
      const today=(await client.query<{today:string}>(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today`)).rows[0]!.today;
      if (input.due_date<today) throw new Error('due_date_invalid');
      // Mesma ordem do motor legado: comprador/unidade antes das linhas de estoque.
      const buyer=await resolveWholesaleBuyer(client,input.environment,{
        partner_id:request.partner_id,items:[],created_by:input.actor,idempotency_key:request.id,
      });
      await resolveWholesalePartnerUnit(client,input.environment,request.partner_id,request.partner_unit_id);
      await changeRequestReservation(client,request,items,-1);
      const sale=await registerWholesaleSaleOnClient(client,{
        environment:input.environment,customer_id:buyer.id,partner_id:request.partner_id,partner_unit_id:request.partner_unit_id,
        payment_status:'pending',due_date:input.due_date,created_by:input.actor,
        idempotency_key:`partner-request:${request.id}:dispatch`,notes:`Pedido CMP vinculado: ${request.id}`,
        items:items.map(i=>({measure:i.measure,brand:i.brand,tire_condition:i.tire_condition,
          quantity:i.quantity,unit_price:Number(i.unit_price_cents)/100})),
      },true);
      await client.query(`UPDATE commerce.partner_wholesale_requests SET status='dispatched',dispatched_at=now(),
        dispatched_by=$3,wholesale_order_id=$4 WHERE id=$1 AND environment=$2`,
        [request.id,input.environment,input.actor,sale.order_id]);
      // Produto do catálogo acompanha a compra: custo de aquisição, sem sobrescrever varejo.
      const links=await client.query(`UPDATE commerce.partner_wholesale_request_items r SET wholesale_order_item_id=i.id
        FROM commerce.wholesale_order_items i WHERE r.request_id=$1 AND r.environment=$2
          AND i.order_id=$3 AND i.environment=r.environment AND i.measure=r.measure AND i.brand=r.brand
          AND i.tire_condition=r.tire_condition`, [request.id,input.environment,sale.order_id]);
      if (links.rowCount!==items.length) throw new Error('request_item_link_conflict');
      const products=await client.query(`UPDATE commerce.partner_purchase_items p SET product_id=r.product_id,
        tire_width_mm=ts.width_mm,tire_aspect_ratio=ts.aspect_ratio,tire_rim_diameter=ts.rim_diameter
        FROM commerce.partner_wholesale_request_items r
        JOIN commerce.products product ON product.id=r.product_id AND product.environment=r.environment AND product.deleted_at IS NULL
        JOIN commerce.tire_specs ts ON ts.product_id=product.id AND ts.environment=product.environment
        WHERE r.request_id=$1 AND r.environment=$2 AND p.environment=r.environment
          AND p.source_wholesale_order_item_id=r.wholesale_order_item_id
          AND COALESCE(ts.vehicle_type,r.vehicle_type)=r.vehicle_type
          AND commerce.catalog_measure_identity(ts.tire_size)=commerce.catalog_measure_identity(r.measure)
          AND commerce.catalog_brand_identity(product.brand)=commerce.catalog_brand_identity(r.brand)`,
        [request.id,input.environment]);
      if (products.rowCount!==items.length) throw new Error('request_purchase_link_conflict');
    }
    const status=input.action==='approve'?'approved':input.action==='reject'?'rejected':'dispatched';
    await recordIntegrityEvent(client,{environment:input.environment,domain:'partner_wholesale_request',
      entityTable:'commerce.partner_wholesale_requests',entityId:request.id,eventType:status,actorLabel:input.actor,
      idempotencyKey:`partner-request:${request.id}:${input.action}`,
      after:{status,reason:input.reason ?? null,due_date:input.due_date ?? null}});
    return {request_id:request.id,status,idempotent:false};
  },dbPool);
}
