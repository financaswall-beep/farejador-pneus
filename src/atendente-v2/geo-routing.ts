/**
 * Filtros PUROS de proximidade do motor da Rede (passos ② e ④a do pipeline).
 *
 * Ver docs/PLANO_CAMADA_GEO_PROXIMIDADE_REDE_2026-06-06.md §3 e §5.5.
 *
 * Estes são os filtros baratos e SEM I/O: modalidade (a loja faz entrega/retirada?)
 * e cobertura declarada de bairro (só pra ENTREGA, decisão D6). O passo de DISTÂNCIA
 * (④b/④c) é a `selectWithinExpandingRing` (shared/geo/ring.ts); o de ESTOQUE (③) é
 * DB (mapProductToPartnerStock) — ficam no chamador (fulfillment), que compõe tudo.
 *
 * Ordem no chamador: modo+cobertura (aqui, de graça) → estoque (DB) → anel (puro).
 * A régua de justiça decide DEPOIS, entre o pool — não muda nada aqui.
 */
import type { GeoPoint } from '../shared/geo/haversine.js';

export type Modalidade = 'delivery' | 'pickup';
export type ServiceMode = 'delivery' | 'pickup' | 'both';

export interface GeoRoutingCandidate {
  unitId: string;
  /** Modo de atendimento da loja (network.partner_units.service_mode). */
  serviceMode: ServiceMode;
  /** Coordenada da loja; null = sem coordenada cadastrada (não entra no anel). */
  location: GeoPoint | null;
  /** A unidade cobre a CIDADE inteira? (alguma linha unit_coverage com kind='city'). */
  hasCityCoverage: boolean;
  /** Bairros canônicos declarados (unit_coverage kind='neighborhood'). */
  neighborhoods: string[];
}

/** A loja atende a modalidade pedida? (`both` atende as duas.) */
export function servesModalidade(serviceMode: ServiceMode, modalidade: Modalidade): boolean {
  if (modalidade === 'delivery') return serviceMode === 'delivery' || serviceMode === 'both';
  return serviceMode === 'pickup' || serviceMode === 'both';
}

/**
 * ④a — cobertura declarada de bairro. Vale SÓ pra ENTREGA (D6); na retirada NÃO
 * filtra (o cliente é que vai à loja). Regra (§6):
 *  - cobre a cidade inteira (city) → passa sempre;
 *  - cobre só bairros (neighborhood) → o bairro do cliente tem que estar na lista;
 *  - sem bairro do cliente resolvido → só passa quem cobre a cidade inteira
 *    (não promete entrega num bairro que a loja não declarou).
 */
export function passesDeliveryCoverage(
  cand: GeoRoutingCandidate,
  clientNeighborhoodCanonical: string | null,
): boolean {
  if (cand.hasCityCoverage) return true;
  if (!clientNeighborhoodCanonical) return false;
  return cand.neighborhoods.includes(clientNeighborhoodCanonical);
}

/**
 * Aplica modo (②) + cobertura na entrega (④a). Função pura, não muta a entrada.
 * Retira (pickup) ignora a cobertura de bairro de propósito (D6). O resultado vai
 * pro filtro de estoque (DB) e depois pro anel.
 */
export function filterByModeAndCoverage<T extends GeoRoutingCandidate>(
  candidates: T[],
  modalidade: Modalidade,
  clientNeighborhoodCanonical: string | null,
): T[] {
  return candidates.filter((c) => {
    if (!servesModalidade(c.serviceMode, modalidade)) return false;
    if (modalidade === 'delivery' && !passesDeliveryCoverage(c, clientNeighborhoodCanonical)) return false;
    return true;
  });
}

/** Anéis de entrega vs retirada — a régua de raio por modalidade (D1/D2).
 *  Ambas as modalidades usam ANÉIS crescentes (faixas): a loja na faixa mais perto
 *  ganha; lojas na mesma faixa revezam pela régua. (Retirada deixou de ser raio único
 *  pra ter faixas de ~5 km — decisão Wallace 2026-06-08.) */
export function ringsForModalidade(
  modalidade: Modalidade,
  deliveryRings: readonly number[],
  pickupRings: readonly number[],
): readonly number[] {
  return modalidade === 'pickup' ? pickupRings : deliveryRings;
}

// Re-export pra o chamador montar o anel sobre o resultado destes filtros.
export type { GeoPoint };
