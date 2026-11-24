import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { decideStoreGeoOrFallback } from './delivery-quote-routing.js';
import { resolveMatrizUnitId, getUnitDisplayById, matrizDistanceKm } from './fulfillment.js';
import { deliveryBlockResponse } from './matriz-delivery-settings.js';
import { GROUP_ROUTE_CHANGED, verifyGroupFulfillment } from './stock-group-offer.js';

export async function quoteGroupFreight(
  client: PoolClient, environment: Environment, conversationId: string, requestId: string | null,
  args: Record<string, unknown>,
): Promise<string> {
  const group = await verifyGroupFulfillment(client, environment, conversationId,
    requestId, args, 'delivery');
  if (!group) return JSON.stringify(GROUP_ROUTE_CHANGED);
  const decision = await decideStoreGeoOrFallback(client, environment, conversationId, {
    municipio: group.location.municipio, bairro: args.bairro as string | undefined,
    items: [{ product_id: group.quote.product_id, quantity: group.quote.quantidade }],
    modality: 'quote', fullAddress: args.endereco_entrega as string | undefined,
  });
  if (decision.blockReason) return JSON.stringify(deliveryBlockResponse(decision.blockReason));
  if (decision.routing || decision.onlyFar || decision.matrizFreight == null) return JSON.stringify(GROUP_ROUTE_CHANGED);
  return JSON.stringify({
    encontrado: true, disponivel: true, valor: decision.matrizFreight.toFixed(2),
    municipio: group.location.municipio, delivery_mode: 'delivery', geo_resolution_id: null,
    ...(decision.matrizPolicyText ? { politica_entrega_matriz: decision.matrizPolicyText } : {}),
  });
}

export async function quoteGroupPickup(
  client: PoolClient, environment: Environment, conversationId: string, requestId: string | null,
  args: Record<string, unknown>,
): Promise<string> {
  const group = await verifyGroupFulfillment(client, environment, conversationId,
    requestId, args, 'pickup');
  if (!group) return JSON.stringify(GROUP_ROUTE_CHANGED);
  const unitId = await resolveMatrizUnitId(client, environment);
  if (!unitId) return JSON.stringify(GROUP_ROUTE_CHANGED);
  const store = await getUnitDisplayById(client, environment, unitId);
  const km = group.location.customerLocation
    ? await matrizDistanceKm(client, group.location.customerLocation) : null;
  const name = store?.nome_loja ?? 'Matriz';
  const common = { nome_loja: name, horario: store?.opening_hours ?? null,
    taxa_instalacao: store?.installation_fee ?? null, distancia_km: km === null ? null : Math.round(km),
    conjunto_id: group.quote.conjunto_id };
  return JSON.stringify(km !== null && km > 15
    ? { ...common, encontrado: false, motivo: 'retirada_so_longe', nome_loja_distante: name }
    : { ...common, encontrado: true });
}
