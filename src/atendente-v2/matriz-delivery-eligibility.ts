import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import type { GeoPoint } from '../shared/geo/haversine.js';
import { haversineKm } from '../shared/geo/haversine.js';
import { env } from '../shared/config/env.js';
import { cachedRoadDistanceKm } from '../shared/geo/geo-cache.js';
import { getMatrizWholesaleStockQty, checkMatrizGalpaoShortfall } from './wholesale-stock-read.js';
import { readDeliverySettings,matrizOrigin,matrizCoverageBlock,type DeliverySettings,type DeliveryBlock } from './matriz-delivery-settings.js';

export interface MatrixEligibility {
  settings:DeliverySettings|null; origin:GeoPoint; distanceKm:number|null;
  canFulfill:boolean; block:DeliveryBlock|null;
}
export async function evaluateMatrizDelivery(client:PoolClient,environment:Environment,input:{
  items:{ product_id:string; quantity:number }[]; modalidade:'delivery'|'pickup';
  customerLocation:GeoPoint|null; settings?:DeliverySettings|null;
}):Promise<MatrixEligibility> {
  const settings=input.settings===undefined ? (await readDeliverySettings(client,environment))?.settings??null : input.settings;
  const origin=matrizOrigin(settings);
  let distanceKm=input.customerLocation ? haversineKm(input.customerLocation,origin) : null;
  if (input.customerLocation && env.ROUTING_GEO_ROAD_DISTANCE && env.GOOGLE_MAPS_API_KEY) {
    const measured=await cachedRoadDistanceKm(client,input.customerLocation,[origin],env.GOOGLE_MAPS_API_KEY);
    distanceKm=measured?.[0]??distanceKm;
  }
  let block=matrizCoverageBlock(settings,input.modalidade,distanceKm);
  let canFulfill=false;
  if (!block && input.items.length) {
    if (env.WHOLESALE_UNIFIED_STOCK) {
      canFulfill=(await Promise.all(input.items.map(async i=>(await getMatrizWholesaleStockQty(client,environment,i.product_id))>=i.quantity))).every(Boolean);
      // Itens distintos podem consumir o mesmo saldo físico: valida o conjunto.
      if (canFulfill && settings) canFulfill=(await checkMatrizGalpaoShortfall(client,environment,
        input.items.map(i=>({productId:i.product_id,quantity:i.quantity})),false)).length===0;
    } else {
      const result=await client.query<{ product_id:string; available:string }>(
        `SELECT product_id,sum(quantity_available)::text AS available FROM commerce.stock_levels
         WHERE environment=$1 AND product_id=ANY($2::uuid[]) GROUP BY product_id`,[environment,input.items.map(i=>i.product_id)]);
      canFulfill=input.items.every(i=>Number(result.rows.find(r=>r.product_id===i.product_id)?.available??0)>=i.quantity);
    }
    if (!canFulfill && settings) block='insufficient_stock';
  }
  return { settings,origin,distanceKm,canFulfill,block };
}
