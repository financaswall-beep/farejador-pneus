import { describe, expect, it } from 'vitest';
import { haversineKm, type GeoPoint } from '../../../src/shared/geo/haversine.js';

const COPACABANA: GeoPoint = { lat: -22.984613, lng: -43.198278 };
const BARRA: GeoPoint = { lat: -23.001191, lng: -43.414283 };

describe('haversineKm', () => {
  it('mesmo ponto → 0', () => {
    expect(haversineKm(COPACABANA, COPACABANA)).toBeCloseTo(0, 6);
  });

  it('1° de latitude ≈ 111.2 km (pega raio/graus errados)', () => {
    const d = haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });

  it('1° de longitude encurta com a latitude (pega troca lat/lng)', () => {
    // No equador 1° lng ≈ 111 km; a 45° ≈ 78.6 km (cos45). Se lat/lng
    // estivessem trocados, ambos dariam ~111 e este teste quebraria.
    const atEquator = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    const at45 = haversineKm({ lat: 45, lng: 0 }, { lat: 45, lng: 1 });
    expect(atEquator).toBeGreaterThan(110);
    expect(atEquator).toBeLessThan(112);
    expect(at45).toBeGreaterThan(77);
    expect(at45).toBeLessThan(80);
  });

  it('simétrica: a→b == b→a', () => {
    expect(haversineKm(COPACABANA, BARRA)).toBeCloseTo(haversineKm(BARRA, COPACABANA), 9);
  });

  it('Copacabana ↔ Barra da Tijuca ≈ 22 km em linha reta', () => {
    const d = haversineKm(COPACABANA, BARRA);
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(24);
  });
});
