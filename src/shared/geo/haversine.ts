/**
 * Distância em LINHA RETA (haversine) entre dois pontos lat/lng, em km.
 *
 * Camada de proximidade (GEO) do motor de distribuição da Rede.
 * Ver docs/PLANO_CAMADA_GEO_PROXIMIDADE_REDE_2026-06-06.md §5.2.
 *
 * FUNÇÃO PURA — só matemática. Sem I/O, sem relógio, sem dependência externa.
 * Mesmas entradas → mesma saída. É a rede de segurança (decisão D5) quando o
 * Google falha ou não há chave, e o pré-filtro barato antes de pedir distância
 * de rua. NÃO é a verdade final de "quão longe pela rua" — é a linha reta.
 */

export interface GeoPoint {
  /** Latitude em graus decimais (ex.: -22.9846). */
  lat: number;
  /** Longitude em graus decimais (ex.: -43.1983). */
  lng: number;
}

/** Raio médio da Terra em km (IUGG). */
const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Distância do grande círculo entre `a` e `b`, em km (haversine).
 * Simétrica: haversineKm(a, b) === haversineKm(b, a). Mesmo ponto → 0.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
