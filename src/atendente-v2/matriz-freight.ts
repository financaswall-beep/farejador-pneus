/**
 * Frete da MATRIZ por DISTÂNCIA — lógica PURA (sem env/banco), testável como
 * geo-routing.ts / ring.ts. A maquinaria que MEDE a distância (Google/haversine,
 * precisa de banco) vive em fulfillment.ts (`matrizDistanceKm`); aqui fica só a
 * coordenada da Matriz e a tabela de preço, que são o contrato de negócio.
 */
import type { GeoPoint } from '../shared/geo/haversine.js';

export const MATRIZ_MAX_DELIVERY_KM = 55;
export interface MatrizFreight {
  first_limit_km:number; first_price_brl:number;
  second_limit_km:number; second_price_brl:number; above_price_brl:number;
}
/** Tabela anterior, usada até o proprietário salvar outros valores. */
export const DEFAULT_MATRIZ_FREIGHT:Readonly<MatrizFreight> = Object.freeze({
  first_limit_km:15, first_price_brl:9.9,
  second_limit_km:25, second_price_brl:13, above_price_brl:19,
});

/**
 * Coordenada da MATRIZ (de onde ela despacha) — pino que o dono mandou 2026-06-19
 * (lugar "Petiti", região São Gonçalo/Maricá). A matriz é central virtual: não é
 * parceiro e não tem coordenada no banco (core.units não tem lat/long), então fica
 * aqui como constante, no mesmo espírito do FRETE_PADRAO_BRL. Se a matriz mudar de
 * endereço, troca aqui.
 */
export const MATRIZ_COORD: GeoPoint = { lat: -22.8777701, lng: -42.9900824 };

/**
 * Link do Google Maps do galpão da matriz (Petiti/SG-Maricá) — confirmado pelo dono
 * 2026-06-27. Usado pelo bot na retirada (Tijolo 3) igual ao maps_url dos parceiros.
 */
export const MATRIZ_MAPS_URL = 'https://maps.app.goo.gl/mECGFRkZw2ztpTf17';

/**
 * Frete da MATRIZ por DISTÂNCIA. Tabela original (decisão Wallace 2026-06-19):
 *   ≤ 15 km → R$ 9,90 · ≤ 25 km → R$ 13,00 · acima de 25 km → R$ 19,00 (última faixa/teto).
 * O cadastro de entrega pode substituir as duas distâncias e os três valores.
 * `km` desconhecido retorna a primeira faixa para preservar o caminho legado;
 * com cadastro ativo, o chamador bloqueia entrega sem localização confirmada.
 * Esta tabela só vale quando a MATRIZ entrega; parceiros mantêm o frete da rede.
 */
export function matrizFreightForKm(km: number | null | undefined, freight:MatrizFreight=DEFAULT_MATRIZ_FREIGHT): number {
  // A cobertura é validada antes da cobrança. A última faixa não autoriza entrega fora do raio.
  if (km == null || !Number.isFinite(km) || km <= freight.first_limit_km) return freight.first_price_brl;
  if (km <= freight.second_limit_km) return freight.second_price_brl;
  return freight.above_price_brl;
}
