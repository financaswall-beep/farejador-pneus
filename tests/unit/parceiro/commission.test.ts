import { describe, it, expect } from 'vitest';
import { lineCommission, type PartnerCommissionConfig } from '../../../src/parceiro/commission.js';

const percent = (value: number, active = true): PartnerCommissionConfig => ({ kind: 'percent', value, active });
const fixed = (value: number, active = true): PartnerCommissionConfig => ({ kind: 'fixed', value, active });

describe('lineCommission — comissão por venda (Bloco 2, 0100)', () => {
  it('inativa (sem config / active=false) = 0', () => {
    expect(lineCommission(percent(5, false), 100)).toBe(0);
    expect(lineCommission(fixed(10, false), 100)).toBe(0);
    expect(lineCommission({ kind: 'percent', value: 0, active: false }, 999)).toBe(0);
  });

  it('fixo = valor por venda (independe do valor da venda)', () => {
    expect(lineCommission(fixed(10), 100)).toBe(10);
    expect(lineCommission(fixed(7.5), 9999)).toBe(7.5);
    expect(lineCommission(fixed(0), 100)).toBe(0);
  });

  it('percentual: arredonda a centavo metade-pra-cima, igual ao NUMERIC do Postgres', () => {
    // round(amount * value/100, 2) — os mesmos números do card da equipe (SQL).
    expect(lineCommission(percent(5), 100)).toBe(5);        // 5.000  → 5.00
    expect(lineCommission(percent(5), 99.9)).toBe(5);       // 4.995  → 5.00 (metade-pra-cima)
    expect(lineCommission(percent(5), 33.33)).toBe(1.67);   // 1.6665 → 1.67
    expect(lineCommission(percent(2.5), 10.1)).toBe(0.25);  // 0.2525 → 0.25
    expect(lineCommission(percent(5), 0.1)).toBe(0.01);     // 0.005  → 0.01 (metade-pra-cima)
    expect(lineCommission(percent(5), 1.1)).toBe(0.06);     // 0.055  → 0.06
  });

  it('CONCILIAÇÃO: soma das linhas == total que o dono confere na mão', () => {
    const cfg = percent(5);
    const vendas = [99.9, 33.33, 100, 0.1]; // 5.00 + 1.67 + 5.00 + 0.01
    const linhas = vendas.map((v) => lineCommission(cfg, v));
    expect(linhas).toEqual([5, 1.67, 5, 0.01]);
    const totalCentavos = linhas.reduce((s, v) => s + Math.round(v * 100), 0);
    expect(totalCentavos / 100).toBe(11.68);
  });

  it('fixo: total = quantidade de vendas × valor', () => {
    const cfg = fixed(10);
    const vendas = [50, 120, 9.9];
    const total = vendas.reduce((s, v) => s + Math.round(lineCommission(cfg, v) * 100), 0) / 100;
    expect(total).toBe(30); // 3 vendas × R$10
  });
});
