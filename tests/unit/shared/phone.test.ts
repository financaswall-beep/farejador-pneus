/**
 * Testes unitários da normalização E.164 — S4 da auditoria 2026-05-21.
 */

import { describe, expect, it } from 'vitest';
import { normalizeBrazilianPhone, normalizeCheckoutPhone, containsCheckoutPhone } from '../../../src/shared/phone.js';

describe('telefone completo para checkout', () => {
  it.each(['2198765565', '+552198765565', '98765565', '(21) 9876-5565', '219876556', '21abc999991111'])('recusa %s sem completar dígitos', value => {
    expect(normalizeCheckoutPhone(value)).toBeNull();
  });
  it.each([
    ['(21) 99999-1111', '+5521999991111'], ['21999991111', '+5521999991111'],
    ['+55 (21) 99999-1111', '+5521999991111'], ['5521999991111', '+5521999991111'],
    ['(21) 2222-3333', '+552122223333'], ['+14155552671', '+14155552671'],
  ])('aceita formato completo %s', (value, expected) => expect(normalizeCheckoutPhone(value)).toBe(expected));
  it('localiza o número em uma resposta junto do endereço e pagamento', () => {
    expect(containsCheckoutPhone('Rua Exemplo 38 (21) 99999-1111 vou pagar no pix', '+5521999991111')).toBe(true);
    expect(containsCheckoutPhone('Rua Exemplo 38 2198765565 pix', '+5521998765565')).toBe(false);
    expect(containsCheckoutPhone('Pedido 1219999911117', '+5521999991111')).toBe(false);
  });
});

describe('normalizeBrazilianPhone', () => {
  it('aceita mascara brasileira com parenteses e hifen', () => {
    expect(normalizeBrazilianPhone('(21) 99999-9999')).toBe('+5521999999999');
  });

  it('aceita ddd + numero cru', () => {
    expect(normalizeBrazilianPhone('21999999999')).toBe('+5521999999999');
  });

  it('aceita ddd + fixo (10 digitos)', () => {
    expect(normalizeBrazilianPhone('2122223333')).toBe('+552122223333');
  });

  it('aceita 55 ja prefixado sem +', () => {
    expect(normalizeBrazilianPhone('5521999999999')).toBe('+5521999999999');
  });

  it('preserva E.164 ja correto', () => {
    expect(normalizeBrazilianPhone('+5521999999999')).toBe('+5521999999999');
  });

  it('aceita E.164 estrangeiro valido', () => {
    expect(normalizeBrazilianPhone('+14155552671')).toBe('+14155552671');
  });

  it('remove espacos e pontos', () => {
    expect(normalizeBrazilianPhone(' 21 9.9999.9999 ')).toBe('+5521999999999');
  });

  it('retorna null para string vazia', () => {
    expect(normalizeBrazilianPhone('')).toBeNull();
    expect(normalizeBrazilianPhone('   ')).toBeNull();
  });

  it('retorna null para input null/undefined', () => {
    expect(normalizeBrazilianPhone(null)).toBeNull();
    expect(normalizeBrazilianPhone(undefined)).toBeNull();
  });

  it('retorna null para texto nao-numerico', () => {
    expect(normalizeBrazilianPhone('xyz')).toBeNull();
    expect(normalizeBrazilianPhone('abc-def')).toBeNull();
  });

  it('retorna null para numero curto demais', () => {
    expect(normalizeBrazilianPhone('123')).toBeNull();
    expect(normalizeBrazilianPhone('+1234')).toBeNull();
  });

  it('retorna null para numero comprido demais', () => {
    expect(normalizeBrazilianPhone('1234567890123456')).toBeNull();
  });
});
