/**
 * Frete da MATRIZ por DISTÂNCIA — lógica PURA (sem env/banco), testável como
 * geo-routing.ts / ring.ts. A maquinaria que MEDE a distância (Google/haversine,
 * precisa de banco) vive em fulfillment.ts (`matrizDistanceKm`); aqui fica só a
 * coordenada da Matriz e a tabela de preço, que são o contrato de negócio.
 */
import type { GeoPoint } from '../shared/geo/haversine.js';

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
 * Frete da MATRIZ por DISTÂNCIA (decisão Wallace 2026-06-19). A matriz é o backstop
 * universal e pode ser puxada pra longe — o frete escala pra não dar prejuízo:
 *   ≤ 15 km → R$ 9,90 · ≤ 25 km → R$ 13,00 · acima de 25 km → R$ 19,00 (última faixa/teto).
 * `km` null/desconhecido (cliente sem coordenada) → R$ 9,90 (= a faixa 1, o fixo da rede):
 * sem como medir, cobra o base. SÓ vale quando a MATRIZ entrega; o parceiro local segue
 * no fixo da rede (promessa do "frete fixo R$ 9,90").
 */
export function matrizFreightForKm(km: number | null | undefined): number {
  if (km == null || !Number.isFinite(km)) return 9.9; // sem distância → base da rede (R$ 9,90)
  if (km <= 15) return 9.9;
  if (km <= 25) return 13;
  return 19;
}
