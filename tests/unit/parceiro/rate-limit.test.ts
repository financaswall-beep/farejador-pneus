/**
 * Testes do rate-limit em memória do login do parceiro — P1 (achado MÉDIO da
 * revisão de segurança). Janela fixa por chave.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { rateLimitHit, __resetRateLimit } from '../../../src/parceiro/rate-limit.js';

beforeEach(() => __resetRateLimit());

describe('rate-limit do login', () => {
  it('libera até o limite e bloqueia o que passa', () => {
    const key = 'login:1.2.3.4:loja';
    for (let i = 0; i < 10; i++) {
      expect(rateLimitHit(key, 10, 60_000)).toBe(false); // 10 tentativas ok
    }
    expect(rateLimitHit(key, 10, 60_000)).toBe(true); // 11ª estoura
  });

  it('chaves diferentes não interferem (ip/slug isolados)', () => {
    for (let i = 0; i < 10; i++) rateLimitHit('login:1.1.1.1:a', 10, 60_000);
    expect(rateLimitHit('login:1.1.1.1:a', 10, 60_000)).toBe(true);   // estourou
    expect(rateLimitHit('login:2.2.2.2:a', 10, 60_000)).toBe(false);  // outro IP, livre
    expect(rateLimitHit('login:1.1.1.1:b', 10, 60_000)).toBe(false);  // outro slug, livre
  });

  it('janela expira e reabre as tentativas', () => {
    const key = 'login:9.9.9.9:loja';
    for (let i = 0; i < 10; i++) rateLimitHit(key, 10, -1); // windowMs negativo → já expirado
    // como cada chamada com janela expirada reseta, nunca bloqueia
    expect(rateLimitHit(key, 10, -1)).toBe(false);
  });
});
