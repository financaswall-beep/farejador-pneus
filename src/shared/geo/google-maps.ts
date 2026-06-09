/**
 * Cliente do Google Maps Platform — Geocoding + Distance Matrix.
 *
 * Camada GEO do motor da Rede. Ver
 * docs/PLANO_CAMADA_GEO_PROXIMIDADE_REDE_2026-06-06.md §5.3.
 *
 * `fetch` nativo (sem lib nova). Timeout curto + try/catch: quando o Google
 * falha, estoura o tempo ou não há chave, devolve `null` (geocode) ou elemento
 * `null` (distância) e o CHAMADOR cai no haversine — degrada elegante, nunca
 * trava a conversa (caso H, decisão D5). NÃO importa `env` de propósito (mantém
 * o módulo testável sem ambiente); a `apiKey` vem por parâmetro do caller, que
 * passa `env.GOOGLE_MAPS_API_KEY`.
 */
import { logger } from '../logger.js';
import type { GeoPoint } from './haversine.js';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const DISTANCE_MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';

/** Timeout curto: melhor cair no haversine do que segurar o cliente esperando. */
const GOOGLE_TIMEOUT_MS = 3000;

export interface GeocodeResult extends GeoPoint {
  /** location_type do Google: ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE. */
  confidence: string;
}

/** Coordenada → endereço: o que o pino do cliente revela pra casar com a cobertura. */
export interface ReverseGeocodeResult {
  /** Município (administrative_area_level_2) — a CIDADE que casa com unit_coverage. */
  municipio: string | null;
  /** Bairro (sublocality_level_1 / sublocality / neighborhood), quando o Google trouxer. */
  neighborhood: string | null;
}

interface GeocodeResponse {
  status: string;
  results?: Array<{
    geometry?: { location?: { lat: number; lng: number }; location_type?: string };
  }>;
}

interface ReverseGeocodeResponse {
  status: string;
  results?: Array<{
    address_components?: Array<{ long_name: string; short_name?: string; types: string[] }>;
  }>;
}

interface DistanceMatrixResponse {
  status: string;
  rows?: Array<{ elements?: Array<{ status: string; distance?: { value: number } }> }>;
}

/** GET com timeout. Qualquer falha (HTTP não-ok, abort, parse) → null. Nunca lança. */
async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      logger.warn({ status: res.status }, 'google-maps: HTTP não-ok (cai no fallback)');
      return null;
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    logger.warn({ err }, 'google-maps: fetch falhou (cai no fallback)');
    return null;
  }
}

/**
 * Endereço (texto livre) → coordenada. `null` quando: sem chave, texto vazio,
 * ZERO_RESULTS, ou qualquer falha. `confidence` é o location_type do Google —
 * o chamador decide se confia ou cai no fallback por cidade quando vier fraco.
 */
export async function geocodeAddress(
  text: string,
  apiKey: string | undefined,
): Promise<GeocodeResult | null> {
  if (!apiKey || !text.trim()) return null;

  const params = new URLSearchParams({
    address: text,
    key: apiKey,
    region: 'br',
    language: 'pt-BR',
  });

  const json = (await fetchJson(`${GEOCODE_URL}?${params.toString()}`)) as GeocodeResponse | null;
  if (!json || json.status !== 'OK') {
    if (json && json.status && json.status !== 'ZERO_RESULTS') {
      logger.warn({ status: json.status }, 'google-maps: geocode status não-OK');
    }
    return null;
  }

  const loc = json.results?.[0]?.geometry?.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;

  return {
    lat: loc.lat,
    lng: loc.lng,
    confidence: json.results?.[0]?.geometry?.location_type ?? 'APPROXIMATE',
  };
}

/**
 * Coordenada (o pino do WhatsApp) → cidade + bairro (reverse geocoding). Existe pro
 * caso "cliente mandou SÓ o pino": o bairro escrito resolve a cidade hoje; o pino não
 * resolvia nada além da distância. `null` quando: sem chave, ZERO_RESULTS, ou qualquer
 * falha — mesmo padrão tolerante do `geocodeAddress` (o chamador cai no "pede o bairro"
 * de hoje). Lê `address_components` (o Google pode espalhar cidade e bairro em results
 * diferentes, então varre todos):
 *  - município = `administrative_area_level_2` (a cidade que casa com `unit_coverage`);
 *  - bairro    = `sublocality_level_1` → `sublocality` → `neighborhood` (o 1º que vier).
 */
export async function reverseGeocode(
  point: GeoPoint,
  apiKey: string | undefined,
): Promise<ReverseGeocodeResult | null> {
  if (!apiKey) return null;

  const params = new URLSearchParams({
    latlng: `${point.lat},${point.lng}`,
    key: apiKey,
    language: 'pt-BR',
    region: 'br',
  });

  const json = (await fetchJson(
    `${GEOCODE_URL}?${params.toString()}`,
  )) as ReverseGeocodeResponse | null;
  if (!json || json.status !== 'OK') {
    if (json && json.status && json.status !== 'ZERO_RESULTS') {
      logger.warn({ status: json.status }, 'google-maps: reverse geocode status não-OK');
    }
    return null;
  }

  let municipio: string | null = null;
  let neighborhood: string | null = null;
  for (const result of json.results ?? []) {
    for (const comp of result.address_components ?? []) {
      const types = comp.types ?? [];
      if (!municipio && types.includes('administrative_area_level_2')) {
        municipio = comp.long_name;
      }
      if (
        !neighborhood &&
        (types.includes('sublocality_level_1') ||
          types.includes('sublocality') ||
          types.includes('neighborhood'))
      ) {
        neighborhood = comp.long_name;
      }
    }
    if (municipio && neighborhood) break;
  }

  if (!municipio && !neighborhood) return null;
  return { municipio, neighborhood };
}

/**
 * Distância de RUA (km) de 1 origem (cliente) para N destinos (lojas), na ordem
 * dos destinos. Devolve:
 *  - `null`              → a chamada inteira falhou (sem chave, status global
 *                          não-OK, erro/timeout) → chamador usa haversine pra TODOS.
 *  - `(number|null)[]`   → por destino: km, ou `null` se aquele trecho não rotear
 *                          (NOT_FOUND/ZERO_RESULTS) → chamador usa haversine só nele.
 *  - `[]`                → quando não há destinos (sem chamar a rede).
 */
export async function roadDistanceKm(
  origin: GeoPoint,
  destinations: GeoPoint[],
  apiKey: string | undefined,
): Promise<(number | null)[] | null> {
  if (!apiKey) return null;
  if (destinations.length === 0) return [];

  const params = new URLSearchParams({
    origins: `${origin.lat},${origin.lng}`,
    destinations: destinations.map((d) => `${d.lat},${d.lng}`).join('|'),
    key: apiKey,
    mode: 'driving',
    language: 'pt-BR',
    region: 'br',
  });

  const json = (await fetchJson(
    `${DISTANCE_MATRIX_URL}?${params.toString()}`,
  )) as DistanceMatrixResponse | null;
  if (!json || json.status !== 'OK') {
    if (json && json.status) {
      logger.warn({ status: json.status }, 'google-maps: distancematrix status não-OK');
    }
    return null;
  }

  const elements = json.rows?.[0]?.elements;
  // Defensivo: a contagem tem que casar com os destinos, senão não dá pra alinhar.
  if (!elements || elements.length !== destinations.length) return null;

  return elements.map((el) =>
    el.status === 'OK' && el.distance ? el.distance.value / 1000 : null,
  );
}
