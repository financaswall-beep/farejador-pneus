/**
 * Cache de geocodificação/distância (commerce.geo_cache, migration 0098) —
 * read-through sobre o cliente Google (google-maps.ts, que permanece puro,
 * sem banco e sem env — este módulo é a camada de cima).
 *
 * Por quê: geocode de bairro/endereço e distância cliente→loja repetem MUITO
 * entre conversas, e o Google cobra por chamada (Distance Matrix por elemento).
 * O cache corta o custo que cresce linear com o volume (auditoria 360°
 * 2026-06-12) e tira latência da resposta do bot.
 *
 * Contrato (mesma filosofia do google-maps.ts — degrada elegante):
 *  - FAIL-OPEN: qualquer erro de banco no cache → chama o Google direto;
 *    o cache NUNCA derruba a conversa.
 *  - O cache NUNCA inventa: guarda exatamente a resposta que o Google deu;
 *    falha/ZERO_RESULTS (null) NÃO entra (pode ser transitória).
 *  - TTL 90 dias na leitura; faxina semanal pg_cron apaga >120d (0098).
 *  - GEO_CACHE=false desliga (volta a chamar o Google sempre).
 *
 * Import por NAMESPACE de propósito: testes que mockam google-maps.js com
 * factory parcial (só geocodeAddress) não quebram os outros nomes.
 */
import type { PoolClient } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { GeoPoint } from './haversine.js';
import * as google from './google-maps.js';
import type { GeocodeResult, ReverseGeocodeResult } from './google-maps.js';

export interface RoadInfo { km: number | null; durationMinutes: number | null }

const TTL = '90 days';

/** 4 casas ≈ 11 m — junta pinos da mesma casa sem misturar vizinhos. */
const pt = (p: GeoPoint): string => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

export function geocodeCacheKey(text: string): string {
  return `g:${text.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export function reverseCacheKey(point: GeoPoint): string {
  return `r:${pt(point)}`;
}

export function distanceCacheKey(origin: GeoPoint, dest: GeoPoint): string {
  return `d:${pt(origin)}>${pt(dest)}`;
}

async function readMany(client: PoolClient, keys: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (keys.length === 0) return out;
  const r = await client.query<{ cache_key: string; value: unknown }>(
    `SELECT cache_key, value FROM commerce.geo_cache
      WHERE cache_key = ANY($1) AND created_at > now() - interval '${TTL}'`,
    [keys],
  );
  for (const row of r.rows) out.set(row.cache_key, row.value);
  return out;
}

interface CacheEntry {
  key: string;
  kind: 'geocode' | 'reverse' | 'distance';
  value: unknown;
}

async function writeMany(client: PoolClient, entries: CacheEntry[]): Promise<void> {
  // Dedup por chave: ON CONFLICT não aceita a mesma linha 2x no mesmo INSERT
  // (duas lojas no mesmo prédio arredondam pra mesma coordenada).
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const unique = [...byKey.values()];
  if (unique.length === 0) return;
  await client.query(
    `INSERT INTO commerce.geo_cache (cache_key, kind, value)
     SELECT * FROM unnest($1::text[], $2::text[], $3::jsonb[])
     ON CONFLICT (cache_key) DO UPDATE SET value = EXCLUDED.value, created_at = now()`,
    [unique.map((e) => e.key), unique.map((e) => e.kind), unique.map((e) => JSON.stringify(e.value))],
  );
}

/** geocodeAddress com cache. Mesmo contrato: null quando sem chave/texto/falha. */
export async function cachedGeocodeAddress(
  client: PoolClient,
  text: string,
  apiKey: string | undefined,
): Promise<GeocodeResult | null> {
  if (!env.GEO_CACHE || !apiKey || !text.trim()) return google.geocodeAddress(text, apiKey);

  const key = geocodeCacheKey(text);
  try {
    const hit = (await readMany(client, [key])).get(key) as GeocodeResult | undefined;
    if (hit && typeof hit.lat === 'number' && typeof hit.lng === 'number') return hit;
  } catch (err) {
    logger.warn({ err }, 'geo-cache: leitura falhou (segue pro Google)');
  }

  const fresh = await google.geocodeAddress(text, apiKey);
  if (fresh) {
    try {
      await writeMany(client, [{ key, kind: 'geocode', value: fresh }]);
    } catch (err) {
      logger.warn({ err }, 'geo-cache: escrita falhou (ignorada)');
    }
  }
  return fresh;
}

/** reverseGeocode com cache. Mesmo contrato: null quando sem chave/falha. */
export async function cachedReverseGeocode(
  client: PoolClient,
  point: GeoPoint,
  apiKey: string | undefined,
): Promise<ReverseGeocodeResult | null> {
  if (!env.GEO_CACHE || !apiKey) return google.reverseGeocode(point, apiKey);

  const key = reverseCacheKey(point);
  try {
    const hit = (await readMany(client, [key])).get(key) as ReverseGeocodeResult | undefined;
    if (hit && ('municipio' in hit || 'neighborhood' in hit)) return hit;
  } catch (err) {
    logger.warn({ err }, 'geo-cache: leitura falhou (segue pro Google)');
  }

  const fresh = await google.reverseGeocode(point, apiKey);
  if (fresh) {
    try {
      await writeMany(client, [{ key, kind: 'reverse', value: fresh }]);
    } catch (err) {
      logger.warn({ err }, 'geo-cache: escrita falhou (ignorada)');
    }
  }
  return fresh;
}

/**
 * roadDistanceKm com cache POR DESTINO: só os trechos sem cache vão ao Google
 * (1 origem × N misses), e cada km que voltar é guardado. Contrato por elemento
 * igual ao original (km, ou null → chamador mantém o haversine daquele trecho);
 * quando TUDO falha o efeito é o mesmo do null original (nenhum elemento entra).
 */
export async function cachedRoadDistanceKm(
  client: PoolClient,
  origin: GeoPoint,
  destinations: GeoPoint[],
  apiKey: string | undefined,
): Promise<(number | null)[] | null> {
  if (!env.GEO_CACHE) return google.roadDistanceKm(origin, destinations, apiKey);
  if (!apiKey) return null;
  if (destinations.length === 0) return [];

  const keys = destinations.map((d) => distanceCacheKey(origin, d));
  const result: (number | null)[] = new Array<number | null>(destinations.length).fill(null);

  let cached = new Map<string, unknown>();
  try {
    cached = await readMany(client, [...new Set(keys)]);
  } catch (err) {
    logger.warn({ err }, 'geo-cache: leitura falhou (segue pro Google)');
  }

  const missIdx: number[] = [];
  keys.forEach((k, i) => {
    const v = cached.get(k) as { km?: unknown } | undefined;
    if (v && typeof v.km === 'number') result[i] = v.km;
    else missIdx.push(i);
  });

  if (missIdx.length > 0) {
    const fresh = await google.roadDistanceKm(
      origin,
      missIdx.map((i) => destinations[i]!),
      apiKey,
    );
    if (fresh) {
      const writes: CacheEntry[] = [];
      fresh.forEach((km, j) => {
        const i = missIdx[j]!;
        result[i] = km;
        if (km != null) writes.push({ key: keys[i]!, kind: 'distance', value: { km } });
      });
      try {
        await writeMany(client, writes);
      } catch (err) {
        logger.warn({ err }, 'geo-cache: escrita falhou (ignorada)');
      }
    }
  }
  return result;
}

/**
 * Distância + duração de 1 origem → 1 destino com cache. Usado pela matriz pra
 * dizer "fica a ~X km, uns Y min de carro". Reutiliza a chave `d:` do cache de
 * distância mas guarda `{ km, durationMinutes }` em vez de só `{ km }`.
 */
export async function cachedMatrizRoadInfo(
  client: PoolClient,
  origin: GeoPoint,
  dest: GeoPoint,
  apiKey: string | undefined,
): Promise<RoadInfo> {
  const key = distanceCacheKey(origin, dest);
  if (env.GEO_CACHE) {
    try {
      const hit = (await readMany(client, [key])).get(key) as { km?: number; durationMinutes?: number } | undefined;
      // Só aceita hit se tiver km E durationMinutes (entries antigas só têm km → re-chama Google).
      if (hit && typeof hit.km === 'number' && typeof hit.durationMinutes === 'number') {
        return { km: hit.km, durationMinutes: hit.durationMinutes };
      }
    } catch (err) {
      logger.warn({ err }, 'geo-cache: leitura falhou (segue pro Google)');
    }
  }
  const fresh = await google.roadDistanceAndDuration(origin, dest, apiKey);
  if (fresh.km != null && env.GEO_CACHE) {
    try {
      await writeMany(client, [{ key, kind: 'distance', value: { km: fresh.km, durationMinutes: fresh.durationMinutes } }]);
    } catch (err) {
      logger.warn({ err }, 'geo-cache: escrita falhou (ignorada)');
    }
  }
  return fresh;
}
