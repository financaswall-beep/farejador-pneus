import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';

/**
 * geo-cache (0098): read-through sobre o Google. O contrato que NÃO pode quebrar:
 *  - HIT → não paga Google; MISS → paga 1x e guarda;
 *  - FAIL-OPEN: erro de banco nunca derruba a conversa (segue pro Google);
 *  - falha do Google (null) NÃO entra no cache;
 *  - GEO_CACHE=false → comportamento de antes (Google sempre, banco intocado).
 *
 * geo-cache importa env.ts no load → carregar via import dinâmico com o env fake
 * montado antes (mesmo padrão de reconcile-jobs.test.ts).
 */

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

const geocodeAddress = vi.fn();
const reverseGeocode = vi.fn();
const roadDistanceKm = vi.fn();

async function loadGeoCache(geoCacheFlag: 'true' | 'false' = 'true') {
  vi.resetModules();
  Object.assign(process.env, baseEnv, { GEO_CACHE: geoCacheFlag });
  vi.doMock('../../../src/shared/geo/google-maps.js', () => ({
    geocodeAddress,
    reverseGeocode,
    roadDistanceKm,
  }));
  return import('../../../src/shared/geo/geo-cache.js');
}

interface QueryCall {
  text: string;
  values: unknown[];
}

/** Client fake: SELECT devolve `rows`; INSERT devolve vazio. `fail` → tudo lança. */
function fakeClient(
  rows: { cache_key: string; value: unknown }[] = [],
  opts: { fail?: boolean } = {},
): PoolClient & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (opts.fail) throw new Error('banco caiu');
      if (text.includes('SELECT cache_key')) return { rows };
      return { rows: [] };
    },
  } as unknown as PoolClient & { calls: QueryCall[] };
}

const inserts = (c: { calls: QueryCall[] }) => c.calls.filter((q) => q.text.includes('INSERT'));

beforeEach(() => {
  geocodeAddress.mockReset();
  reverseGeocode.mockReset();
  roadDistanceKm.mockReset();
});

describe('chaves de cache', () => {
  it('geocode: normaliza caixa e espaços (mesma pergunta = mesma chave)', async () => {
    const mod = await loadGeoCache();
    expect(mod.geocodeCacheKey('  Lapa,   RIO de Janeiro ')).toBe('g:lapa, rio de janeiro');
  });

  it('distância: arredonda a 4 casas (~11 m) — mesma casa junta, vizinho não mistura', async () => {
    const mod = await loadGeoCache();
    const origem = { lat: -22.91351, lng: -43.17912 };
    expect(mod.distanceCacheKey(origem, { lat: -22.9, lng: -43.1 })).toBe(
      'd:-22.9135,-43.1791>-22.9000,-43.1000',
    );
  });
});

describe('cachedGeocodeAddress', () => {
  it('MISS → chama o Google 1x e grava no cache', async () => {
    const mod = await loadGeoCache();
    const fresh = { lat: -22.9135, lng: -43.1791, confidence: 'ROOFTOP' };
    geocodeAddress.mockResolvedValueOnce(fresh);
    const client = fakeClient([]);
    expect(await mod.cachedGeocodeAddress(client, 'Lapa, Rio', 'KEY')).toEqual(fresh);
    expect(geocodeAddress).toHaveBeenCalledTimes(1);
    expect(inserts(client)).toHaveLength(1);
  });

  it('HIT → devolve do cache e NÃO paga o Google', async () => {
    const mod = await loadGeoCache();
    const hit = { lat: -22.9135, lng: -43.1791, confidence: 'ROOFTOP' };
    const client = fakeClient([{ cache_key: mod.geocodeCacheKey('Lapa, Rio'), value: hit }]);
    expect(await mod.cachedGeocodeAddress(client, 'Lapa, Rio', 'KEY')).toEqual(hit);
    expect(geocodeAddress).not.toHaveBeenCalled();
    expect(inserts(client)).toHaveLength(0);
  });

  it('Google falhou (null) → NÃO grava (falha pode ser transitória)', async () => {
    const mod = await loadGeoCache();
    geocodeAddress.mockResolvedValueOnce(null);
    const client = fakeClient([]);
    expect(await mod.cachedGeocodeAddress(client, 'Lapa, Rio', 'KEY')).toBeNull();
    expect(inserts(client)).toHaveLength(0);
  });

  it('FAIL-OPEN: banco lança → segue pro Google e devolve o resultado', async () => {
    const mod = await loadGeoCache();
    const fresh = { lat: -22.9, lng: -43.1, confidence: 'APPROXIMATE' };
    geocodeAddress.mockResolvedValueOnce(fresh);
    const client = fakeClient([], { fail: true });
    expect(await mod.cachedGeocodeAddress(client, 'Lapa, Rio', 'KEY')).toEqual(fresh);
    expect(geocodeAddress).toHaveBeenCalledTimes(1);
  });

  it('GEO_CACHE=false → Google direto, banco intocado (comportamento de antes)', async () => {
    const mod = await loadGeoCache('false');
    const fresh = { lat: -22.9, lng: -43.1, confidence: 'ROOFTOP' };
    geocodeAddress.mockResolvedValueOnce(fresh);
    const client = fakeClient([]);
    expect(await mod.cachedGeocodeAddress(client, 'Lapa, Rio', 'KEY')).toEqual(fresh);
    expect(client.calls).toHaveLength(0);
  });

  it('sem chave do Google → delega (contrato original: null)', async () => {
    const mod = await loadGeoCache();
    geocodeAddress.mockResolvedValueOnce(null);
    const client = fakeClient([]);
    expect(await mod.cachedGeocodeAddress(client, 'Lapa, Rio', undefined)).toBeNull();
    expect(client.calls).toHaveLength(0); // cache nem tenta sem chave
  });
});

describe('cachedReverseGeocode', () => {
  it('HIT → devolve do cache sem pagar o Google', async () => {
    const mod = await loadGeoCache();
    const hit = { municipio: 'rio de janeiro', neighborhood: 'Lapa' };
    const point = { lat: -22.9135, lng: -43.1791 };
    const client = fakeClient([{ cache_key: mod.reverseCacheKey(point), value: hit }]);
    expect(await mod.cachedReverseGeocode(client, point, 'KEY')).toEqual(hit);
    expect(reverseGeocode).not.toHaveBeenCalled();
  });

  it('MISS → Google 1x e grava', async () => {
    const mod = await loadGeoCache();
    const fresh = { municipio: 'niteroi', neighborhood: 'Fonseca' };
    reverseGeocode.mockResolvedValueOnce(fresh);
    const client = fakeClient([]);
    expect(await mod.cachedReverseGeocode(client, { lat: -22.88, lng: -43.09 }, 'KEY')).toEqual(fresh);
    expect(reverseGeocode).toHaveBeenCalledTimes(1);
    expect(inserts(client)).toHaveLength(1);
  });
});

describe('cachedRoadDistanceKm (cache POR DESTINO)', () => {
  const origem = { lat: -22.9, lng: -43.2 };
  const lojas = [
    { lat: -22.91, lng: -43.21 }, // A
    { lat: -22.92, lng: -43.22 }, // B
    { lat: -22.93, lng: -43.23 }, // C
  ];

  it('hit parcial: só os MISSES vão ao Google; ordem do resultado preservada', async () => {
    const mod = await loadGeoCache();
    // B está em cache (7.5 km); A e C são miss.
    const client = fakeClient([
      { cache_key: mod.distanceCacheKey(origem, lojas[1]!), value: { km: 7.5 } },
    ]);
    roadDistanceKm.mockResolvedValueOnce([3.2, 11.8]); // Google responde A e C, nessa ordem
    const r = await mod.cachedRoadDistanceKm(client, origem, lojas, 'KEY');
    expect(r).toEqual([3.2, 7.5, 11.8]);
    expect(roadDistanceKm).toHaveBeenCalledTimes(1);
    expect(roadDistanceKm.mock.calls[0]![1]).toEqual([lojas[0], lojas[2]]); // só A e C
    expect(inserts(client)).toHaveLength(1); // grava os 2 kms novos
  });

  it('tudo em cache → ZERO chamada ao Google', async () => {
    const mod = await loadGeoCache();
    const client = fakeClient(
      lojas.map((l, i) => ({ cache_key: mod.distanceCacheKey(origem, l), value: { km: i + 1 } })),
    );
    expect(await mod.cachedRoadDistanceKm(client, origem, lojas, 'KEY')).toEqual([1, 2, 3]);
    expect(roadDistanceKm).not.toHaveBeenCalled();
  });

  it('Google devolve null num trecho → trecho fica null (chamador mantém haversine) e NÃO grava', async () => {
    const mod = await loadGeoCache();
    const client = fakeClient([]);
    roadDistanceKm.mockResolvedValueOnce([4.1, null, 9.9]);
    const r = await mod.cachedRoadDistanceKm(client, origem, lojas, 'KEY');
    expect(r).toEqual([4.1, null, 9.9]);
    const ins = inserts(client);
    expect(ins).toHaveLength(1);
    expect((ins[0]!.values[0] as string[]).length).toBe(2); // só os 2 kms válidos entram
  });

  it('FAIL-OPEN: banco lança → mede tudo no Google como antes', async () => {
    const mod = await loadGeoCache();
    const client = fakeClient([], { fail: true });
    roadDistanceKm.mockResolvedValueOnce([1.1, 2.2, 3.3]);
    expect(await mod.cachedRoadDistanceKm(client, origem, lojas, 'KEY')).toEqual([1.1, 2.2, 3.3]);
    expect(roadDistanceKm).toHaveBeenCalledTimes(1);
  });

  it('sem chave → null (contrato original); sem destino → []', async () => {
    const mod = await loadGeoCache();
    const client = fakeClient([]);
    expect(await mod.cachedRoadDistanceKm(client, origem, lojas, undefined)).toBeNull();
    expect(await mod.cachedRoadDistanceKm(client, origem, [], 'KEY')).toEqual([]);
    expect(roadDistanceKm).not.toHaveBeenCalled();
  });

  it('GEO_CACHE=false → delega direto pro Google, banco intocado', async () => {
    const mod = await loadGeoCache('false');
    roadDistanceKm.mockResolvedValueOnce([5.5, 6.6, 7.7]);
    const client = fakeClient([]);
    expect(await mod.cachedRoadDistanceKm(client, origem, lojas, 'KEY')).toEqual([5.5, 6.6, 7.7]);
    expect(client.calls).toHaveLength(0);
  });
});
