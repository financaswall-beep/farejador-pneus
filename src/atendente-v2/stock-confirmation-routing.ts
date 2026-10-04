import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import type { GeoPoint } from '../shared/geo/haversine.js';
import { decideConfiguredStore } from './configured-routing.js';
import { decideStoreForItems, resolveMunicipioFromBairro, normalizeRegion } from './fulfillment.js';
import { fillCityFromPin } from './delivery-quote-routing.js';
import { resolveCustomerLocation } from './customer-location.js';
import { env } from '../shared/config/env.js';

export interface StockConfirmationItem { product_id:string; quantity:number }
export interface StockConfirmationLocation {
  municipio:string|null; modalidade:'pickup'|'delivery';
  customerLocation:GeoPoint|null; clientNeighborhoodCanonical:string|null;
}
export async function confirmationLocation(client:PoolClient,environment:Environment,conversationId:string,
  args:Record<string,unknown>):Promise<StockConfirmationLocation> {
  const bairro=typeof args.bairro==='string'?args.bairro:null;
  const city=await resolveMunicipioFromBairro(client,environment,bairro??'',args.municipio as string|undefined);
  const { municipio,neighborhoodCanonical }=await fillCityFromPin(client,environment,conversationId,
    {municipio:city,neighborhoodCanonical:bairro?normalizeRegion(bairro):null});
  const customerLocation=await resolveCustomerLocation(client,environment,conversationId,{
    municipio,bairro,fullAddress:args.endereco_entrega as string|undefined,apiKey:env.GOOGLE_MAPS_API_KEY});
  return {municipio,customerLocation,clientNeighborhoodCanonical:neighborhoodCanonical,
    modalidade:args.modalidade==='delivery'?'delivery':env.PICKUP_TO_PARTNER?'pickup':'delivery'};
}
export async function routeStockConfirmation(client:PoolClient,environment:Environment,
  location:StockConfirmationLocation,items:StockConfirmationItem[],excludedUnitIds:string[]=[],onlyUnitId?:string) {
  if(location.customerLocation) return decideConfiguredStore(client,environment,{
    ...location,municipio:location.municipio??'',customerLocation:location.customerLocation,items,excludedUnitIds,onlyUnitId});
  // Sem coordenada mantém a cobertura atual; não inventa distância/loja próxima.
  const routing=location.modalidade==='delivery'
    ?await decideStoreForItems(client,environment,{municipio:location.municipio,items,excludedUnitIds,onlyUnitId}):null;
  return routing?{kind:'partner' as const,routing}:{kind:'matriz' as const,canFulfill:false};
}
