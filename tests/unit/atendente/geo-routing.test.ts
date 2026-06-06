import { describe, expect, it } from 'vitest';
import {
  filterByModeAndCoverage,
  passesDeliveryCoverage,
  ringsForModalidade,
  servesModalidade,
  type GeoRoutingCandidate,
} from '../../../src/atendente-v2/geo-routing.js';

function cand(over: Partial<GeoRoutingCandidate> & { unitId: string }): GeoRoutingCandidate {
  return {
    serviceMode: 'both',
    location: { lat: -22.9, lng: -43.1 },
    hasCityCoverage: true,
    neighborhoods: [],
    ...over,
  };
}

describe('servesModalidade', () => {
  it('delivery: delivery e both atendem; pickup-only não', () => {
    expect(servesModalidade('delivery', 'delivery')).toBe(true);
    expect(servesModalidade('both', 'delivery')).toBe(true);
    expect(servesModalidade('pickup', 'delivery')).toBe(false);
  });
  it('pickup: pickup e both atendem; delivery-only não', () => {
    expect(servesModalidade('pickup', 'pickup')).toBe(true);
    expect(servesModalidade('both', 'pickup')).toBe(true);
    expect(servesModalidade('delivery', 'pickup')).toBe(false);
  });
});

describe('passesDeliveryCoverage (4a)', () => {
  it('cobre a cidade inteira → passa sempre, mesmo sem bairro do cliente', () => {
    expect(passesDeliveryCoverage(cand({ unitId: 'A', hasCityCoverage: true }), null)).toBe(true);
  });
  it('cobre só bairros: passa se o bairro do cliente está na lista', () => {
    const c = cand({ unitId: 'A', hasCityCoverage: false, neighborhoods: ['copacabana', 'ipanema'] });
    expect(passesDeliveryCoverage(c, 'copacabana')).toBe(true);
    expect(passesDeliveryCoverage(c, 'tijuca')).toBe(false);
  });
  it('cobre só bairros e bairro do cliente desconhecido → NÃO passa (não promete)', () => {
    const c = cand({ unitId: 'A', hasCityCoverage: false, neighborhoods: ['copacabana'] });
    expect(passesDeliveryCoverage(c, null)).toBe(false);
  });
});

describe('filterByModeAndCoverage', () => {
  it('entrega: tira pickup-only e bairro não declarado (caso D)', () => {
    const cands = [
      cand({ unitId: 'cidade', serviceMode: 'both', hasCityCoverage: true }),
      cand({ unitId: 'bairro-ok', serviceMode: 'delivery', hasCityCoverage: false, neighborhoods: ['copacabana'] }),
      cand({ unitId: 'bairro-no', serviceMode: 'delivery', hasCityCoverage: false, neighborhoods: ['tijuca'] }),
      cand({ unitId: 'so-retira', serviceMode: 'pickup', hasCityCoverage: true }),
    ];
    const out = filterByModeAndCoverage(cands, 'delivery', 'copacabana').map((c) => c.unitId);
    expect(out).toEqual(['cidade', 'bairro-ok']);
  });
  it('retirada: ignora cobertura de bairro (D6) e tira delivery-only', () => {
    const cands = [
      cand({ unitId: 'so-entrega', serviceMode: 'delivery', hasCityCoverage: false, neighborhoods: ['x'] }),
      cand({ unitId: 'retira-bairro', serviceMode: 'pickup', hasCityCoverage: false, neighborhoods: ['tijuca'] }),
      cand({ unitId: 'both', serviceMode: 'both', hasCityCoverage: true }),
    ];
    // Na retirada o bairro do cliente é irrelevante → 'retira-bairro' passa mesmo
    // sem cobrir copacabana.
    const out = filterByModeAndCoverage(cands, 'pickup', 'copacabana').map((c) => c.unitId);
    expect(out).toEqual(['retira-bairro', 'both']);
  });
  it('não muta a entrada', () => {
    const cands = [cand({ unitId: 'A' }), cand({ unitId: 'B' })];
    const snap = cands.map((c) => c.unitId);
    filterByModeAndCoverage(cands, 'delivery', null);
    expect(cands.map((c) => c.unitId)).toEqual(snap);
  });
});

describe('ringsForModalidade', () => {
  it('entrega usa os anéis crescentes; retirada usa o raio único', () => {
    expect(ringsForModalidade('delivery', [10, 20, 30], 15)).toEqual([10, 20, 30]);
    expect(ringsForModalidade('pickup', [10, 20, 30], 15)).toEqual([15]);
  });
});
