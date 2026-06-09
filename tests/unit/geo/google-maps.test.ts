import { afterEach, describe, expect, it, vi } from 'vitest';
import { geocodeAddress, reverseGeocode, roadDistanceKm } from '../../../src/shared/geo/google-maps.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('geocodeAddress', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sem chave → null, NÃO chama a rede', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await geocodeAddress('Av Atlântica 1700, Copacabana', undefined)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('texto vazio → null, NÃO chama a rede', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await geocodeAddress('   ', 'k')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OK → coordenada + confidence; manda address/key/region', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'OK',
        results: [{ geometry: { location: { lat: -22.98, lng: -43.19 }, location_type: 'ROOFTOP' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await geocodeAddress('Av Atlântica 1700, Copacabana', 'k');
    expect(r).toEqual({ lat: -22.98, lng: -43.19, confidence: 'ROOFTOP' });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('key=k');
    expect(url).toContain('Copacabana');
    expect(url).toContain('region=br');
  });

  it('ZERO_RESULTS → null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'ZERO_RESULTS', results: [] })));
    expect(await geocodeAddress('lugar que não existe', 'k')).toBeNull();
  });

  it('fetch lança (timeout/abort) → null, não propaga', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('aborted')));
    expect(await geocodeAddress('Rua X', 'k')).toBeNull();
  });

  it('HTTP não-ok → null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 500)));
    expect(await geocodeAddress('Rua X', 'k')).toBeNull();
  });
});

describe('reverseGeocode', () => {
  afterEach(() => vi.unstubAllGlobals());

  const COMP = (long: string, types: string[]) => ({ long_name: long, short_name: long, types });

  it('sem chave → null, NÃO chama a rede', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await reverseGeocode({ lat: -22.98, lng: -43.19 }, undefined)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OK → município (admin_area_level_2) + bairro (sublocality); manda latlng/key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'OK',
        results: [
          {
            address_components: [
              COMP('Copacabana', ['sublocality_level_1', 'sublocality', 'political']),
              COMP('Rio de Janeiro', ['administrative_area_level_2', 'political']),
              COMP('Rio de Janeiro', ['administrative_area_level_1', 'political']),
            ],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await reverseGeocode({ lat: -22.98, lng: -43.19 }, 'k');
    expect(r).toEqual({ municipio: 'Rio de Janeiro', neighborhood: 'Copacabana' });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('latlng=-22.98%2C-43.19');
    expect(url).toContain('key=k');
  });

  it('cidade e bairro em results DIFERENTES → varre todos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          status: 'OK',
          results: [
            { address_components: [COMP('Bangu', ['sublocality_level_1', 'sublocality'])] },
            { address_components: [COMP('Rio de Janeiro', ['administrative_area_level_2'])] },
          ],
        }),
      ),
    );
    expect(await reverseGeocode({ lat: -22.8, lng: -43.4 }, 'k')).toEqual({
      municipio: 'Rio de Janeiro',
      neighborhood: 'Bangu',
    });
  });

  it('só bairro (sem admin_area_2) → municipio null, neighborhood preenchido', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ status: 'OK', results: [{ address_components: [COMP('Centro', ['neighborhood'])] }] }),
      ),
    );
    expect(await reverseGeocode({ lat: 0, lng: 0 }, 'k')).toEqual({ municipio: null, neighborhood: 'Centro' });
  });

  it('sem componente útil → null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ status: 'OK', results: [{ address_components: [COMP('Brasil', ['country'])] }] }),
      ),
    );
    expect(await reverseGeocode({ lat: 0, lng: 0 }, 'k')).toBeNull();
  });

  it('ZERO_RESULTS → null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'ZERO_RESULTS', results: [] })));
    expect(await reverseGeocode({ lat: 0, lng: 0 }, 'k')).toBeNull();
  });

  it('fetch lança (timeout/abort) → null, não propaga', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('aborted')));
    expect(await reverseGeocode({ lat: 0, lng: 0 }, 'k')).toBeNull();
  });

  it('HTTP não-ok → null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 500)));
    expect(await reverseGeocode({ lat: 0, lng: 0 }, 'k')).toBeNull();
  });
});

describe('roadDistanceKm', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sem chave → null, NÃO chama a rede (chamador usa haversine)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await roadDistanceKm({ lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }], undefined)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('destinos vazio → [] sem chamar a rede', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await roadDistanceKm({ lat: 0, lng: 0 }, [], 'k')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OK → metros viram km, alinhado aos destinos; NOT_FOUND vira null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'OK',
        rows: [{ elements: [{ status: 'OK', distance: { value: 12000 } }, { status: 'NOT_FOUND' }] }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await roadDistanceKm(
      { lat: -22.9, lng: -43.1 },
      [{ lat: -22.8, lng: -43.2 }, { lat: -23.0, lng: -43.4 }],
      'k',
    );
    expect(r).toEqual([12, null]);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('origins=');
    expect(url).toContain('destinations=');
  });

  it('status global não-OK → null (chamador usa haversine pra todos)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'REQUEST_DENIED' })));
    expect(await roadDistanceKm({ lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }], 'k')).toBeNull();
  });

  it('contagem de elementos ≠ destinos → null (defensivo, não dá pra alinhar)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 1000 } }] }] })),
    );
    expect(await roadDistanceKm({ lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], 'k')).toBeNull();
  });
});
