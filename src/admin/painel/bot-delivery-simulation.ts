import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { geocodeAddress } from '../../shared/geo/google-maps.js';
import { haversineKm } from '../../shared/geo/haversine.js';
import { decideConfiguredStore } from '../../atendente-v2/configured-routing.js';
import { evaluateMatrizDelivery } from '../../atendente-v2/matriz-delivery-eligibility.js';
import type { DeliverySettings } from '../../atendente-v2/matriz-delivery-settings.js';
import { resolveUnitCandidatesByProximity,resolveDistances,mapProductToPartnerStock,
  toGeoRoutingCandidate,FRETE_PADRAO_BRL,matrizFreightForKm } from '../../atendente-v2/fulfillment.js';
import { filterByModeAndRadiusPresence } from '../../atendente-v2/geo-routing.js';
import type { RoutingDiagnostic } from '../../atendente-v2/geo-delivery-trace.js';

export async function deliveryProducts(search:string,db:Pool=pool) {
  const result=await db.query(`SELECT p.id,p.product_name,p.brand,p.tire_condition,
    (SELECT ts.tire_size FROM commerce.tire_specs ts WHERE ts.environment=p.environment AND ts.product_id=p.id LIMIT 1) AS tire_size
    FROM commerce.products p WHERE p.environment=$1 AND p.deleted_at IS NULL
    AND (p.product_name ILIKE $2 OR p.product_code ILIKE $2 OR EXISTS
      (SELECT 1 FROM commerce.tire_specs ts WHERE ts.environment=p.environment AND ts.product_id=p.id AND ts.tire_size ILIKE $2))
    ORDER BY p.product_name,p.id LIMIT 25`,[env.FAREJADOR_ENV,`%${search}%`]);
  return result.rows;
}
export async function geocodeDeliveryAddress(address:string) {
  const location=await geocodeAddress(address,env.GOOGLE_MAPS_API_KEY);
  if (!location) throw new Error('delivery_address_not_found');
  return location;
}
export async function simulateBotDelivery(input:{address:string;settings:DeliverySettings;
  items:{product_id:string;quantity:number}[]},db:Pool=pool) {
  const location=await geocodeDeliveryAddress(input.address);
  const items=Array.from(input.items.reduce((m,i)=>m.set(i.product_id,(m.get(i.product_id)??0)+i.quantity),
    new Map<string,number>()),([product_id,quantity])=>({product_id,quantity}));
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='8000ms'");
    const valid=await client.query(`SELECT id FROM commerce.products WHERE environment=$1 AND deleted_at IS NULL AND id=ANY($2::uuid[])`,
      [env.FAREJADOR_ENV,items.map(i=>i.product_id)]);
    if (valid.rows.length!==items.length) throw new Error('delivery_product_not_found');
    const matrix=await evaluateMatrizDelivery(client,env.FAREJADOR_ENV,{items,modalidade:'delivery',customerLocation:location,settings:input.settings});
    const candidates=await resolveUnitCandidatesByProximity(client,env.FAREJADOR_ENV);
    const eligibleIds=new Set(filterByModeAndRadiusPresence(candidates.map(toGeoRoutingCandidate),'delivery').map(c=>c.unitId));
    const distances=await resolveDistances(client,location,candidates.filter(c=>c.location&&eligibleIds.has(c.ctx.unitId)).map(c=>({unitId:c.ctx.unitId,location:c.location!})),40);
    const diagnostics:RoutingDiagnostic[]=[];
    for(const c of candidates){
      const km=distances.get(c.ctx.unitId)??(c.location?haversineKm(location,c.location):null);
      let reason=c.serviceMode==='pickup'?'pickup_only':km==null?'needs_location':c.deliveryRadiusKm==null?'radius_missing':
        km>c.deliveryRadiusKm?'outside_radius':km>40?'outside_ring':'apt';
      if(reason==='apt') {
        const stock=await Promise.all(items.map(i=>mapProductToPartnerStock(client,env.FAREJADOR_ENV,c.ctx.unitId,i.product_id,i.quantity)));
        if(stock.some(s=>!s)) reason='insufficient_stock';
      }
      diagnostics.push({unitId:c.ctx.unitId,name:c.ctx.unitName,location:c.location,distanceKm:km,radiusKm:c.deliveryRadiusKm,reason});
    }
    // Chama a mesma função do bot; não cria pedido, reserva, conversa ou evento de roteamento.
    const decision=await decideConfiguredStore(client,env.FAREJADOR_ENV,{municipio:'',items,modalidade:'delivery',
      customerLocation:location,clientNeighborhoodCanonical:null},input.settings);
    const selected=decision.kind==='partner'?decision.routing.unitId:
      decision.kind==='matriz'&&decision.canFulfill&&!decision.blockReason?'matriz':null;
    diagnostics.push({unitId:'matriz',name:'Matriz',location:matrix.origin,distanceKm:matrix.distanceKm,
      radiusKm:input.settings.radius_km,reason:matrix.block??(matrix.canFulfill?'apt':'insufficient_stock')});
    diagnostics.forEach(d=>{d.selected=d.unitId===selected;if(d.selected&&decision.kind==='partner')d.distanceKm=decision.distanceKm;});
    const chosen=diagnostics.find(d=>d.selected);
    return {location,origin:matrix.origin,selected,store:chosen?.name??null,
      reason:decision.blockReason??(decision.kind==='only_far'?'only_far':!selected?'unavailable':
        selected==='matriz'?(diagnostics.some(d=>d.unitId!=='matriz'&&d.reason==='apt')?'matriz_closer':'matriz_fallback'):'partner_fairness'),
      distance_km:chosen?.distanceKm??null,
      freight:selected==='matriz'?matrizFreightForKm(matrix.distanceKm,input.settings.freight):selected?FRETE_PADRAO_BRL:null,
      delivery_days:selected==='matriz'?input.settings.delivery_days:null,
      diagnostics:diagnostics.sort((a,b)=>Number(b.selected)-Number(a.selected)||(a.distanceKm??Infinity)-(b.distanceKm??Infinity)),
      approximate:location.confidence!=='ROOFTOP'&&location.confidence!=='RANGE_INTERPOLATED',
      draft:true,matriz_competes:env.ROUTING_MATRIZ_COMPETES};
  } finally {try {await client.query('ROLLBACK');} finally {client.release();}}
}
