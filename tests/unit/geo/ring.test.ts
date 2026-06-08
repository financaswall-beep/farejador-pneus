import { describe, expect, it } from 'vitest';
import {
  GEO_PICKUP_RADIUS_KM,
  GEO_PICKUP_RING_KM,
  GEO_RING_KM,
  selectWithinExpandingRing,
} from '../../../src/shared/geo/ring.js';

interface Loja {
  id: string;
  km: number;
}
const dist = (l: Loja) => l.km;

describe('selectWithinExpandingRing', () => {
  it('elegíveis vazio → pool vazio, sem anel, sem longe', () => {
    const r = selectWithinExpandingRing<Loja>([], dist, GEO_RING_KM);
    expect(r).toEqual({ pool: [], ringKm: null, onlyFar: [] });
  });

  it('todos dentro do 1º anel → pool completo no menor anel (10 km)', () => {
    const lojas = [{ id: 'A', km: 3 }, { id: 'B', km: 8 }];
    const r = selectWithinExpandingRing(lojas, dist, GEO_RING_KM);
    expect(r.ringKm).toBe(10);
    expect(r.pool.map((l) => l.id)).toEqual(['A', 'B']);
    expect(r.onlyFar).toEqual([]);
  });

  it('pega o MENOR anel não-vazio (não infla o pool)', () => {
    // 5 cabe no anel 10; 12/25 não. Pool tem que ser só [5], anel 10.
    const lojas = [{ id: 'A', km: 5 }, { id: 'B', km: 12 }, { id: 'C', km: 25 }];
    const r = selectWithinExpandingRing(lojas, dist, GEO_RING_KM);
    expect(r.ringKm).toBe(10);
    expect(r.pool.map((l) => l.id)).toEqual(['A']);
  });

  it('expande quando o 1º anel está vazio (10 → 20)', () => {
    const lojas = [{ id: 'B', km: 12 }, { id: 'C', km: 18 }, { id: 'D', km: 25 }];
    const r = selectWithinExpandingRing(lojas, dist, GEO_RING_KM);
    expect(r.ringKm).toBe(20);
    expect(r.pool.map((l) => l.id)).toEqual(['B', 'C']); // 25 fica fora
  });

  it('só tem LONGE (além do maior anel) → pool vazio, onlyFar ASC por km', () => {
    const lojas = [{ id: 'X', km: 55 }, { id: 'Y', km: 45 }];
    const r = selectWithinExpandingRing(lojas, dist, GEO_RING_KM);
    expect(r.pool).toEqual([]);
    expect(r.ringKm).toBeNull();
    expect(r.onlyFar.map((l) => l.id)).toEqual(['Y', 'X']); // 45 antes de 55
  });

  it('retirada: anel único de 15 km', () => {
    const dentro = selectWithinExpandingRing([{ id: 'A', km: 12 }], dist, [GEO_PICKUP_RADIUS_KM]);
    expect(dentro.ringKm).toBe(15);
    expect(dentro.pool.map((l) => l.id)).toEqual(['A']);
    const fora = selectWithinExpandingRing([{ id: 'B', km: 20 }], dist, [GEO_PICKUP_RADIUS_KM]);
    expect(fora.pool).toEqual([]);
    expect(fora.onlyFar.map((l) => l.id)).toEqual(['B']);
  });

  it('limite do anel é inclusivo (≤)', () => {
    const r = selectWithinExpandingRing([{ id: 'A', km: 10 }], dist, GEO_RING_KM);
    expect(r.ringKm).toBe(10);
    expect(r.pool.map((l) => l.id)).toEqual(['A']);
  });

  it('não muta a entrada', () => {
    const lojas = [{ id: 'A', km: 25 }, { id: 'B', km: 5 }];
    const snap = lojas.map((l) => l.id);
    selectWithinExpandingRing(lojas, dist, GEO_RING_KM);
    expect(lojas.map((l) => l.id)).toEqual(snap);
  });

  it('anéis fora de ordem são tratados como crescentes', () => {
    const r = selectWithinExpandingRing([{ id: 'A', km: 12 }], dist, [30, 10, 20]);
    expect(r.ringKm).toBe(20); // ordenado → 10,20,30 → menor não-vazio = 20
  });

  it('constantes de negócio (D1/D2)', () => {
    expect([...GEO_RING_KM]).toEqual([10, 20, 30, 40]);
    expect(GEO_PICKUP_RADIUS_KM).toBe(15);
    expect([...GEO_PICKUP_RING_KM]).toEqual([5, 10, 15]);
  });

  it('retirada em faixas: loja na faixa mais perto ganha; mesma faixa reveza', () => {
    // Méier a 2 km (faixa ≤5) ganha sozinho; Tijuca a 9 km (faixa 10) nem entra no pool.
    const cachambi = selectWithinExpandingRing(
      [{ id: 'Méier', km: 2 }, { id: 'Tijuca', km: 9 }], dist, GEO_PICKUP_RING_KM);
    expect(cachambi.ringKm).toBe(5);
    expect(cachambi.pool.map((l) => l.id)).toEqual(['Méier']);
    // Duas lojas coladas (mesma faixa ≤5) → as duas no pool (régua desempata fora daqui).
    const coladas = selectWithinExpandingRing(
      [{ id: 'Méier-1', km: 1 }, { id: 'Méier-2', km: 2 }], dist, GEO_PICKUP_RING_KM);
    expect(coladas.ringKm).toBe(5);
    expect(coladas.pool.map((l) => l.id)).toEqual(['Méier-1', 'Méier-2']);
    // Acima de 15 km → só longe (cai na matriz).
    const longe = selectWithinExpandingRing([{ id: 'X', km: 20 }], dist, GEO_PICKUP_RING_KM);
    expect(longe.pool).toEqual([]);
    expect(longe.onlyFar.map((l) => l.id)).toEqual(['X']);
  });
});
