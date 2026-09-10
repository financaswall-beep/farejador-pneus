import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { env } from '../shared/config/env.js';
import { decideStoreForItems,normalizeRegion,matrizFreightForKm,matrizDistanceKm,FRETE_PADRAO_BRL,type PartnerOrderRouting } from './fulfillment.js';
import { getLatestCustomerLocation,resolveCustomerLocation } from './customer-location.js';
import { cachedReverseGeocode } from '../shared/geo/geo-cache.js';
import { decideConfiguredStore as decideStoreForItemsGeo } from './configured-routing.js';
import { readDeliverySettings,deliveryBlockResponse,matrizScheduleText,type DeliveryBlock } from './matriz-delivery-settings.js';
import { evaluateMatrizDelivery } from './matriz-delivery-eligibility.js';
import { recordGeoRoutingDecision,recordPartnerRoutingDecision } from './routing-decisions.js';

// ─── Camada GEO: resolução de loja por proximidade (compartilhada) ───────────
// FONTE ÚNICA da decisão de loja pros dois caminhos (calcular_frete e criar_pedido),
// pra a cotação e o registro nunca divergirem (invariante §5.7). Com ROUTING_GEO on
// e coordenada do cliente → motor de proximidade (anel); senão → caminho de hoje
// (por cidade). A coordenada vem em camadas (resolveCustomerLocation, customer-location.ts):
// pino → endereço completo (rua+número via Google) → bairro; sem nenhuma → cidade (caso F).

/**
 * Pino-first (decisão Wallace 2026-06-09): quando o caminho do BAIRRO DIGITADO não
 * resolveu a CIDADE (`municipio == null`) e há um pino na conversa, reverse-geocoda o
 * pino → cidade (e bairro, se o cliente não digitou). É ADITIVO e NÃO toca a busca por
 * bairro escrito: se a cidade já veio do bairro, devolve a entrada intacta (early
 * return) — o bairro SEMPRE vence e nem chega aqui. Degrada elegante: ROUTING_GEO off /
 * sem chave / sem pino / Google falhou → devolve o que entrou (o bot volta a pedir o
 * bairro, como hoje). O bairro digitado, quando há, mantém prioridade no canônico.
 */
export async function fillCityFromPin(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  current: { municipio: string | null; neighborhoodCanonical: string | null },
): Promise<{ municipio: string | null; neighborhoodCanonical: string | null }> {
  if (current.municipio) return current;
  if (!env.ROUTING_GEO || !env.GOOGLE_MAPS_API_KEY) return current;
  const pin = await getLatestCustomerLocation(client, environment, conversationId);
  if (!pin) return current;
  const rev = await cachedReverseGeocode(client, pin, env.GOOGLE_MAPS_API_KEY);
  if (!rev?.municipio) return current;
  return {
    municipio: rev.municipio,
    neighborhoodCanonical:
      current.neighborhoodCanonical ?? (rev.neighborhood ? normalizeRegion(rev.neighborhood) : null),
  };
}

interface GeoOnlyFar {
  unitId: string;
  unitName: string;
  distanceKm: number;
}

/**
 * Decide a loja (entrega) por proximidade quando ROUTING_GEO está on e há coordenada;
 * senão cai no caminho de hoje (decideStoreForItems por cidade). Retorna o routing
 * (loja escolhida ou null=matriz) e, no caso E (só tem longe), o onlyFar pra o bot
 * dar a resposta honesta (D3). Os DOIS tools chamam isto com as MESMAS entradas.
 */
export async function decideStoreGeoOrFallback(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  input: {
    municipio: string | null;
    items: { product_id: string; quantity: number }[];
    bairro: string | null | undefined;
    modality?: 'delivery' | 'quote';
    /** Endereço completo (rua+número) digitado pelo cliente na ENTREGA — geocodifica fino. */
    fullAddress?: string | null;
  },
): Promise<{
  routing: PartnerOrderRouting | null;
  onlyFar?: GeoOnlyFar;
  // Frete da MATRIZ por distância (só preenchido quando a entrega cai na matriz).
  // Garantido por CÓDIGO (não confiar no valor_frete que o LLM passa).
  matrizFreight?: number;
  matrizDistanceKm?: number | null;
  blockReason?: DeliveryBlock;
  matrizPolicyText?: string;
}> {
  const saved=(await readDeliverySettings(client,environment))?.settings??null;
  if ((env.ROUTING_GEO || saved) && (input.municipio || saved)) {
    const customerLocation = await resolveCustomerLocation(client, environment, conversationId, {
      municipio: input.municipio,
      bairro: input.bairro,
      fullAddress: input.fullAddress,
      apiKey: env.GOOGLE_MAPS_API_KEY,
    });
    if (customerLocation) {
      const geo = await decideStoreForItemsGeo(client, environment, {
        municipio: input.municipio??'',
        items: input.items,
        modalidade: 'delivery', // calcular_frete e o roteamento de pedido do bot são entrega
        customerLocation,
        clientNeighborhoodCanonical: input.bairro ? normalizeRegion(input.bairro) : null,
      },saved);
      if (geo.blockReason) return {routing:null,blockReason:geo.blockReason};
      if (geo.kind === 'partner') {
        await recordGeoRoutingDecision(client,environment,conversationId,geo,input.municipio,input.modality ?? 'delivery');
        return { routing: geo.routing };
      }
      if (geo.kind === 'only_far') {
        await recordGeoRoutingDecision(client,environment,conversationId,geo,input.municipio,input.modality ?? 'delivery');
        return { routing: null, onlyFar: {
          unitId: geo.unitId,unitName: geo.unitName,distanceKm: geo.distanceKm,
        } };
      }
      // matriz: mede cliente→Matriz e cobra o frete por DISTÂNCIA (decisão 06-19).
      const matrix=saved?await evaluateMatrizDelivery(client,environment,{...input,modalidade:'delivery',customerLocation,settings:saved}):null;
      if(matrix?.block)return {routing:null,blockReason:matrix.block};
      const km = matrix?.distanceKm??await matrizDistanceKm(client, customerLocation);
      await recordGeoRoutingDecision(client,environment,conversationId,geo,input.municipio,input.modality ?? 'delivery');
      return { routing: null, matrizFreight: matrizFreightForKm(km), matrizDistanceKm: km,
        ...(saved?{matrizPolicyText:matrizScheduleText(saved)}:{}) };
    }
    // sem coordenada → cai no fallback por cidade (caso F)
  }
  if(saved) return {routing:null,blockReason:'needs_location'};
  const routing = await decideStoreForItems(client, environment, { municipio: input.municipio, items: input.items });
  await recordPartnerRoutingDecision(client, environment, conversationId, {
    unitId: routing?.unitId ?? null,kind: routing ? 'partner' : 'matrix',
    municipio: input.municipio,modality: input.modality ?? 'delivery',
  });
  // matriz sem coordenada (caso F): não dá pra medir distância → frete base da rede.
  return routing ? { routing } : { routing: null, matrizFreight: matrizFreightForKm(null), matrizDistanceKm: null };
}

/**
 * Frete de ENTREGA cotado direto do PINO (flag DELIVERY_FREIGHT_FROM_PIN): quando o cliente
 * já mandou a localização mas não digitou o bairro, cota pela coordenada em vez de exigir o
 * endereço escrito. Usa a MESMA fonte do criar_pedido (decideStoreGeoOrFallback) → a cotação
 * bate com a cobrança (invariante §5.7). Devolve a string JSON pronta pro tool result, ou
 * `null` se não deu pra cotar pelo pino (sem produto escolhido, sem pino, ou sem cidade
 * resolvida) — aí o caller degrada pro fluxo de hoje (pede o bairro/localização). Espelha os
 * mesmos formatos de retorno do enriquecimento por bairro (parceiro fixo / só-longe / matriz
 * por distância), pra o bot tratar igual.
 */
export async function quoteFreteFromPin(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  produtos: { product_id: string; quantidade?: number }[],
): Promise<string | null> {
  // Sem produto escolhido não dá pra decidir a loja (estoque) — logo nem o frete. getRecent
  // já tenta preencher no caller; se ainda vazio, degrada (o bot pede o pneu antes).
  if (produtos.length === 0) return null;
  // Cidade a partir do PINO (fillCityFromPin já exige ROUTING_GEO + chave + pino; sem pino
  // devolve municipio=null). Sem cidade → não cota pelo pino (deixa pedir a localização).
  const { municipio } = await fillCityFromPin(client, environment, conversationId, {
    municipio: null,
    neighborhoodCanonical: null,
  });
  if (!municipio && !(await readDeliverySettings(client,environment))) return null;
  const decision = await decideStoreGeoOrFallback(client, environment, conversationId, {
    municipio,
    items: produtos.map((p) => ({ product_id: p.product_id, quantity: p.quantidade ?? 1 })),
    bairro: undefined,
    modality: 'quote',
  });
  if(decision.blockReason)return JSON.stringify(deliveryBlockResponse(decision.blockReason));
  if (decision.onlyFar) {
    return JSON.stringify({
      encontrado: false,
      disponivel: false,
      apenas_longe: true,
      distancia_km: Math.round(decision.onlyFar.distanceKm),
      nome_loja_distante: decision.onlyFar.unitName,
      orientacao:
        'Esse pneu só tem numa loja mais distante. Seja honesto: avise a distância e ofereça opções (entregar mesmo assim / medida equivalente mais perto / reservar e avisar). NÃO finja que é entrega normal.',
    });
  }
  if (decision.routing) {
    // Entrega por PARCEIRO: frete fixo da rede (mesmo do criar_pedido no caminho parceiro).
    return JSON.stringify({
      encontrado: true,
      disponivel: true,
      valor: FRETE_PADRAO_BRL.toFixed(2),
      municipio,
      delivery_mode: 'delivery',
      geo_resolution_id: null,
      via_pino: true,
    });
  }
  if (decision.matrizFreight != null) {
    // Entrega pela MATRIZ: frete por DISTÂNCIA (mesma tabela por km do criar_pedido).
    return JSON.stringify({
      encontrado: true,
      disponivel: true,
      valor: decision.matrizFreight.toFixed(2),
      ...(decision.matrizPolicyText?{politica_entrega_matriz:decision.matrizPolicyText}:{}),
      municipio,
      distancia_km: decision.matrizDistanceKm != null ? Math.round(decision.matrizDistanceKm) : undefined,
      delivery_mode: 'delivery',
      geo_resolution_id: null,
      via_pino: true,
    });
  }
  return null;
}

