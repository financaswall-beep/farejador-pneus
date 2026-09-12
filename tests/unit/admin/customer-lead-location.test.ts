import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { reverse } = vi.hoisted(() => ({ reverse:vi.fn() }));
vi.mock('../../../src/shared/config/env.js',() => ({ env:{ GOOGLE_MAPS_API_KEY:'test-key' } }));
vi.mock('../../../src/shared/geo/geo-cache.js',() => ({ cachedReverseGeocode:reverse,
  reverseCacheKey:({lat,lng}:{lat:number;lng:number}) => `r:${lat.toFixed(4)},${lng.toFixed(4)}` }));
import { loadCustomerLeadLocations } from '../../../src/admin/painel/customer-lead-location.js';
const typed = { contact_id:'a',source:'typed',observed_at:'2026-09-12',
  fact_value:{ texto_informado:'Sou de Icaraí, Niterói.',bairro:'Icaraí',municipio:'Niterói' } };
const pin = { contact_id:'b',source:'shared_pin',observed_at:'2026-09-12',
  coordinates_lat:'-22.9000',coordinates_lng:'-43.1000',fact_value:null };
const asPool = (query:ReturnType<typeof vi.fn>) => ({ query }) as unknown as Pool;

describe('localização compartilhada entre ficha e Kanban',() => {
  beforeEach(() => reverse.mockReset());
  it('lê uma localização estruturada em lote, com o mesmo resultado da ficha',async () => {
    const query=vi.fn().mockResolvedValue({ rows:[typed] });
    const list=await loadCustomerLeadLocations('prod',['a','a'],asPool(query));
    const detail=await loadCustomerLeadLocations('prod',['a'],asPool(query),{ resolvePin:true });
    expect(list.get('a')).toEqual(detail.get('a'));
    expect(list.get('a')).toMatchObject({ label:'Icaraí — Niterói',source:'typed',estimated_address:'Icaraí, Niterói' });
    expect(query.mock.calls[0][1]).toEqual(['prod',['a']]);
    expect(reverse).not.toHaveBeenCalled();
  });
  it('aproveita pinos em cache em uma única leitura, sem chamadas ao Google pelo quadro',async () => {
    const address={ neighborhood:'Icaraí',municipio:'Niterói',formattedAddress:'Icaraí, Niterói - RJ' };
    const query=vi.fn().mockResolvedValueOnce({ rows:[typed,pin,{ ...pin,contact_id:'c' }] })
      .mockResolvedValueOnce({ rows:[{ cache_key:'r:-22.9000,-43.1000',value:address }] });
    const result=await loadCustomerLeadLocations('test',['a','b','c'],asPool(query));
    expect(result.size).toBe(3);
    expect(result.get('b')).toMatchObject({ label:'Icaraí — Niterói',source:'shared_pin' });
    expect(result.get('b')).toEqual(result.get('c'));
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([['r:-22.9000,-43.1000']]);
    expect(reverse).not.toHaveBeenCalled();
  });
  it('mantém o pino acessível mesmo sem cache ou com geocodificação indisponível',async () => {
    const query=vi.fn().mockResolvedValueOnce({ rows:[pin] }).mockRejectedValueOnce(new Error('cache offline'));
    const list=await loadCustomerLeadLocations('test',['b'],asPool(query));
    reverse.mockRejectedValueOnce(new Error('google offline'));
    query.mockResolvedValueOnce({ rows:[pin] });
    const detail=await loadCustomerLeadLocations('test',['b'],asPool(query),{ resolvePin:true });
    expect(list.get('b')).toEqual(detail.get('b'));
    expect(list.get('b')).toMatchObject({ label:'Localização compartilhada',estimated_address:null,
      maps_url:'https://www.google.com/maps/search/?api=1&query=-22.9%2C-43.1' });
  });
  it('aceita bairro/município estruturados sem texto e preserva o fallback antigo',async () => {
    const query=vi.fn().mockResolvedValue({ rows:[{ ...typed,fact_value:{bairro:'Centro',municipio:'Maricá'} },
      { ...typed,contact_id:'b',source:'legacy',fact_value:'Rio do Ouro' }] });
    const result=await loadCustomerLeadLocations('test',['a','b'],asPool(query));
    expect(result.get('a')?.label).toBe('Centro — Maricá');
    expect(result.get('b')).toMatchObject({ label:'Rio do Ouro',source:'legacy' });
  });
  it('não inventa localização para fatos vazios, coordenadas inválidas ou contatos sem dados',async () => {
    const query=vi.fn().mockResolvedValue({ rows:[{ ...typed,fact_value:{} },{ ...pin,coordinates_lat:999 }] });
    expect((await loadCustomerLeadLocations('test',['a','b'],asPool(query))).size).toBe(0);
    query.mockClear();
    expect((await loadCustomerLeadLocations('test',[],asPool(query))).size).toBe(0);
    expect(query).not.toHaveBeenCalled(); expect(reverse).not.toHaveBeenCalled();
  });
});
