import { describe, expect, it } from 'vitest';
import { matrizFreightForKm, MATRIZ_COORD } from '../../../src/atendente-v2/matriz-freight.js';

// Frete fixo da rede (igual ao FRETE_BASE de fulfillment.ts; aqui literal pra
// manter o teste no módulo PURO, sem puxar a cadeia de env do fulfillment).
const FRETE_BASE = 9.9;

// Frete da MATRIZ por distância (decisão Wallace 2026-06-19):
//   ≤ 15 km → R$ 9,90 · ≤ 25 km → R$ 13,00 · acima de 25 km → R$ 19,00 (última faixa/teto).
// km desconhecido → frete base da rede.
describe('matrizFreightForKm — tabela por distância', () => {
  it('aplica os limites editados e os três preços, incluindo frete grátis',()=>{
    const freight={first_limit_km:20,first_price_brl:0,second_limit_km:40,second_price_brl:17.25,above_price_brl:32.5};
    expect(matrizFreightForKm(20,freight)).toBe(0);
    expect(matrizFreightForKm(20.01,freight)).toBe(17.25);
    expect(matrizFreightForKm(40,freight)).toBe(17.25);
    expect(matrizFreightForKm(40.01,freight)).toBe(32.5);
    expect(matrizFreightForKm(55,freight)).toBe(32.5);
  });
  it('faixa 1: até 15 km = R$ 9,90', () => {
    expect(matrizFreightForKm(0)).toBe(9.9);
    expect(matrizFreightForKm(1)).toBe(9.9);
    expect(matrizFreightForKm(14.9)).toBe(9.9);
    expect(matrizFreightForKm(15)).toBe(9.9); // borda inclusiva
  });

  it('faixa 2: de 15 (exclusive) a 25 km = R$ 13,00', () => {
    expect(matrizFreightForKm(15.01)).toBe(13);
    expect(matrizFreightForKm(20)).toBe(13);
    expect(matrizFreightForKm(25)).toBe(13); // borda inclusiva
  });

  it('faixa 3 (teto): acima de 25 km = R$ 19,00 — inclui 25-30 e além de 30', () => {
    expect(matrizFreightForKm(25.01)).toBe(19);
    expect(matrizFreightForKm(30)).toBe(19);
    expect(matrizFreightForKm(45)).toBe(19); // "acima de 30 = última faixa" (decisão do dono)
    expect(matrizFreightForKm(1000)).toBe(19);
  });

  it('km desconhecido (sem coordenada do cliente) → frete base da rede', () => {
    expect(matrizFreightForKm(null)).toBe(FRETE_BASE);
    expect(matrizFreightForKm(undefined)).toBe(FRETE_BASE);
    expect(matrizFreightForKm(NaN)).toBe(FRETE_BASE);
    expect(matrizFreightForKm(Infinity)).toBe(FRETE_BASE);
  });

  it('o frete base da faixa 1 == o fixo da rede (continuidade: perto da Matriz = mesma promessa)', () => {
    expect(matrizFreightForKm(10)).toBe(FRETE_BASE);
  });
});

describe('MATRIZ_COORD — pino do dono (Petiti, SG/Maricá)', () => {
  it('tem a coordenada que o dono mandou 2026-06-19', () => {
    expect(MATRIZ_COORD).toEqual({ lat: -22.8777701, lng: -42.9900824 });
  });
});
