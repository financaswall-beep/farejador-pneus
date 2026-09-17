import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { env } from '../shared/config/env.js';
import { cachedGeocodeAddress } from '../shared/geo/geo-cache.js';
import { isPreciseGeocode } from './customer-location.js';
import { deliveryAddressHasNumber } from './previous-delivery-address.js';
import { evaluateMatrizDelivery } from './matriz-delivery-eligibility.js';
import { deliveryBlockResponse } from './matriz-delivery-settings.js';
import { MATRIZ_MAX_DELIVERY_KM,matrizFreightForKm } from './matriz-freight.js';
import { matrizStoreHoursText } from './matriz-store-hours.js';

/** A reserva já pertence à Matriz. A retirada só depende de estar habilitada,
 * não de haver outra unidade livre para reservar o mesmo pneu novamente. */
export async function quoteOrderPickupChange(client:PoolClient,environment:Environment) {
  const eligibility=await evaluateMatrizDelivery(client,environment,{
    modalidade:'pickup',customerLocation:null,items:[],
  });
  if(eligibility.block)throw Error(deliveryBlockResponse(eligibility.block).mensagem);
  const settings=eligibility.settings;
  return {nome_loja:'Matriz',endereco:settings?.address??null,
    maps_url:settings?`https://www.google.com/maps/search/?api=1&query=${settings.latitude},${settings.longitude}`:null,
    horario:matrizStoreHoursText(settings?.store_hours)};
}

/** Reavalia a mesma Matriz que já reservou o pedido. Endereço novo nunca usa
 * pino antigo nem troca silenciosamente a loja responsável. */
export async function quoteOrderDeliveryChange(client:PoolClient,environment:Environment,address:string) {
  if(!deliveryAddressHasNumber(address))throw Error('Informe o endereço completo com número e município.');
  const point=await cachedGeocodeAddress(client,address,env.GOOGLE_MAPS_API_KEY);
  if(!isPreciseGeocode(point))throw Error('Não foi possível localizar o novo endereço com precisão. Confira rua, número e município; pedido mantido.');
  const eligibility=await evaluateMatrizDelivery(client,environment,{
    modalidade:'delivery',customerLocation:point,items:[],requireConfiguredDistance:true,
  });
  if(eligibility.block)throw Error(deliveryBlockResponse(eligibility.block).mensagem);
  if(eligibility.distanceKm==null||!Number.isFinite(eligibility.distanceKm)
    ||eligibility.distanceKm>MATRIZ_MAX_DELIVERY_KM)throw Error('Endereço fora da cobertura da Matriz; pedido mantido.');
  return {freight:matrizFreightForKm(eligibility.distanceKm,eligibility.settings?.freight),distanceKm:eligibility.distanceKm};
}
