import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  getLatestCustomerLocation,
  resolveCustomerLocation,
  isPreciseGeocode,
} from '../../../src/atendente-v2/customer-location.js';
import { cachedGeocodeAddress } from '../../../src/shared/geo/geo-cache.js';

// customer-location chama o Google VIA cache (geo-cache.js, 0098); mockar o
// cache evita carregar env.ts (que exigiria variáveis reais no teste).
vi.mock('../../../src/shared/geo/geo-cache.js', () => ({
  cachedGeocodeAddress: vi.fn(),
}));

// A janela de frescor lê env.ts (LOCATION_FRESHNESS_HOURS); mockar mantém o default
// "sem janela" (null) pros testes de sempre e deixa cada teste passar a janela explícita.
vi.mock('../../../src/atendente-v2/location-freshness.js', () => ({
  locationFreshnessHours: () => null,
}));

const geocodeMock = vi.mocked(cachedGeocodeAddress);

interface QueryCall {
  text: string;
  values: unknown[];
}

function clientWithRows(rowSets: unknown[][]): PoolClient & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return { rows: rowSets.shift() ?? [] };
    },
  } as unknown as PoolClient & { calls: QueryCall[] };
}

describe('getLatestCustomerLocation', () => {
  it('sem anexo de localização → null', async () => {
    const client = clientWithRows([[]]);
    expect(await getLatestCustomerLocation(client, 'test', 'conv1')).toBeNull();
  });

  it('lê o pino mais recente; NUMERIC (string do pg) vira number', async () => {
    const client = clientWithRows([[{ coordinates_lat: '-22.984613', coordinates_lng: '-43.198278' }]]);
    expect(await getLatestCustomerLocation(client, 'test', 'conv1')).toEqual({
      lat: -22.984613,
      lng: -43.198278,
    });
  });

  it('escopo certo: file_type=location, environment+conversa, mais recente primeiro', async () => {
    const client = clientWithRows([[{ coordinates_lat: -22.9, coordinates_lng: -43.1 }]]);
    await getLatestCustomerLocation(client, 'prod', 'conv-xyz');
    const call = client.calls[0]!;
    expect(call.text).toContain("file_type = 'location'");
    expect(call.text).toContain('environment = $1');
    expect(call.text).toContain('conversation_id = $2');
    expect(call.text).toContain('ORDER BY created_at DESC');
    expect(call.text).toContain('LIMIT 1');
    expect(call.values).toEqual(['prod', 'conv-xyz']);
  });

  it('coordenada não-numérica → null (defensivo)', async () => {
    const client = clientWithRows([[{ coordinates_lat: 'abc', coordinates_lng: '-43.1' }]]);
    expect(await getLatestCustomerLocation(client, 'test', 'conv1')).toBeNull();
  });

  it('JANELA 6h: filtra por created_at e passa a janela como $3 (só usa pino recente)', async () => {
    const client = clientWithRows([[{ coordinates_lat: -22.9, coordinates_lng: -43.1 }]]);
    await getLatestCustomerLocation(client, 'test', 'conv1', 6);
    const call = client.calls[0]!;
    expect(call.text).toContain('make_interval(hours => $3::int)');
    expect(call.values).toEqual(['test', 'conv1', 6]);
  });

  it('SEM janela (0 ou null): NÃO filtra por tempo — pino vale pra sempre (retrocompat)', async () => {
    const zero = clientWithRows([[{ coordinates_lat: -22.9, coordinates_lng: -43.1 }]]);
    await getLatestCustomerLocation(zero, 'test', 'conv1', 0);
    expect(zero.calls[0]!.text).not.toContain('make_interval');
    expect(zero.calls[0]!.values).toEqual(['test', 'conv1']);

    const nulo = clientWithRows([[{ coordinates_lat: -22.9, coordinates_lng: -43.1 }]]);
    await getLatestCustomerLocation(nulo, 'test', 'conv1', null);
    expect(nulo.calls[0]!.text).not.toContain('make_interval');
    expect(nulo.calls[0]!.values).toEqual(['test', 'conv1']);
  });
});

describe('isPreciseGeocode', () => {
  it('ROOFTOP e RANGE_INTERPOLATED = nível de casa/rua → preciso', () => {
    expect(isPreciseGeocode({ lat: 0, lng: 0, confidence: 'ROOFTOP' })).toBe(true);
    expect(isPreciseGeocode({ lat: 0, lng: 0, confidence: 'RANGE_INTERPOLATED' })).toBe(true);
  });
  it('GEOMETRIC_CENTER, APPROXIMATE e null = vago → NÃO preciso', () => {
    expect(isPreciseGeocode({ lat: 0, lng: 0, confidence: 'GEOMETRIC_CENTER' })).toBe(false);
    expect(isPreciseGeocode({ lat: 0, lng: 0, confidence: 'APPROXIMATE' })).toBe(false);
    expect(isPreciseGeocode(null)).toBe(false);
  });
});

describe('resolveCustomerLocation (camadas: pino → endereço → bairro)', () => {
  it('1) PINO vence — nem chama a Google', async () => {
    geocodeMock.mockReset();
    const client = clientWithRows([[{ coordinates_lat: '-22.9', coordinates_lng: '-43.1' }]]);
    const loc = await resolveCustomerLocation(client, 'test', 'c1', {
      municipio: 'rio de janeiro',
      bairro: 'Lapa',
      fullAddress: 'Rua Teotônio Regadas, 26',
      apiKey: 'KEY',
    });
    expect(loc).toEqual({ lat: -22.9, lng: -43.1 });
    expect(geocodeMock).not.toHaveBeenCalled();
  });

  it('1b) propaga a janela do pino: freshnessHours das opts vira filtro de tempo na busca do pino', async () => {
    geocodeMock.mockReset();
    const client = clientWithRows([[]]); // sem pino DENTRO da janela → cai adiante
    await resolveCustomerLocation(client, 'test', 'c1', {
      municipio: 'rio de janeiro', bairro: 'Lapa', apiKey: 'KEY', freshnessHours: 6,
    });
    const pinoCall = client.calls[0]!; // 1ª query é sempre a busca do pino
    expect(pinoCall.text).toContain('make_interval(hours => $3::int)');
    expect(pinoCall.values).toEqual(['test', 'c1', 6]);
  });

  it('2) sem pino e sem chave → null (não inventa coordenada)', async () => {
    geocodeMock.mockReset();
    const client = clientWithRows([[]]);
    const loc = await resolveCustomerLocation(client, 'test', 'c1', {
      municipio: 'rio de janeiro',
      bairro: 'Lapa',
      fullAddress: 'Rua Teotônio Regadas, 26',
      apiKey: undefined,
    });
    expect(loc).toBeNull();
    expect(geocodeMock).not.toHaveBeenCalled();
  });

  it('3) endereço completo PRECISO (ROOFTOP) → usa a casa; não cai no bairro', async () => {
    geocodeMock.mockReset();
    geocodeMock.mockResolvedValueOnce({ lat: -22.9135, lng: -43.1791, confidence: 'ROOFTOP' });
    const client = clientWithRows([[]]);
    const loc = await resolveCustomerLocation(client, 'test', 'c1', {
      municipio: 'rio de janeiro',
      bairro: 'Lapa',
      fullAddress: 'Rua Teotônio Regadas, 26',
      apiKey: 'KEY',
    });
    expect(loc).toEqual({ lat: -22.9135, lng: -43.1791 });
    expect(geocodeMock).toHaveBeenCalledTimes(1);
    // a rua+número entrou na busca (precisão de verdade, não só o bairro)
    expect(geocodeMock.mock.calls[0]![1]).toContain('Rua Teotônio Regadas, 26');
  });

  it('4) endereço completo VAGO (APPROXIMATE) → cai no paraquedas do bairro', async () => {
    geocodeMock.mockReset();
    geocodeMock
      .mockResolvedValueOnce({ lat: -22.91, lng: -43.18, confidence: 'APPROXIMATE' }) // rua não resolveu fino
      .mockResolvedValueOnce({ lat: -22.9131, lng: -43.1765, confidence: 'APPROXIMATE' }); // centro do bairro
    const client = clientWithRows([[]]);
    const loc = await resolveCustomerLocation(client, 'test', 'c1', {
      municipio: 'rio de janeiro',
      bairro: 'Lapa',
      fullAddress: 'Rua Inexistente, 99999',
      apiKey: 'KEY',
    });
    expect(loc).toEqual({ lat: -22.9131, lng: -43.1765 });
    expect(geocodeMock).toHaveBeenCalledTimes(2);
    // a 2ª busca (paraquedas) é só bairro/cidade — sem a rua
    expect(geocodeMock.mock.calls[1]![1]).not.toContain('Rua Inexistente');
    expect(geocodeMock.mock.calls[1]![1]).toContain('Lapa');
  });

  it('5) sem endereço completo, só bairro → geocoda o bairro (comportamento de hoje)', async () => {
    geocodeMock.mockReset();
    geocodeMock.mockResolvedValueOnce({ lat: -22.9131, lng: -43.1765, confidence: 'APPROXIMATE' });
    const client = clientWithRows([[]]);
    const loc = await resolveCustomerLocation(client, 'test', 'c1', {
      municipio: 'rio de janeiro',
      bairro: 'Lapa',
      apiKey: 'KEY',
    });
    expect(loc).toEqual({ lat: -22.9131, lng: -43.1765 });
    expect(geocodeMock).toHaveBeenCalledTimes(1);
  });

  it('6) endereço vago e bairro não resolve → null', async () => {
    geocodeMock.mockReset();
    geocodeMock
      .mockResolvedValueOnce({ lat: 0, lng: 0, confidence: 'APPROXIMATE' })
      .mockResolvedValueOnce(null);
    const client = clientWithRows([[]]);
    const loc = await resolveCustomerLocation(client, 'test', 'c1', {
      municipio: 'rio de janeiro',
      bairro: 'Lapa',
      fullAddress: 'Rua X',
      apiKey: 'KEY',
    });
    expect(loc).toBeNull();
    expect(geocodeMock).toHaveBeenCalledTimes(2);
  });
});
