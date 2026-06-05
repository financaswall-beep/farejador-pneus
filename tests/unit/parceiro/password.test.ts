/**
 * Testes do helper de senha/sessão do Portal Parceiro — P1 (login de verdade).
 *
 * Pura criptografia (scrypt + sha256), sem banco — roda fora do Docker.
 * Cobre: hash não-reversível, verificação correta/errada em tempo constante,
 * formato do token de sessão e o sha256 que o banco recalcula.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  hashPassword,
  verifyPassword,
  fakeVerify,
  newSessionToken,
  hashSessionToken,
  isSessionToken,
} from '../../../src/parceiro/password.js';

describe('password — hash/verify', () => {
  it('hash não guarda a senha em texto e tem o formato scrypt:salt:hash', async () => {
    const hash = await hashPassword('senha-do-joao');
    expect(hash).not.toContain('senha-do-joao');
    const parts = hash.split(':');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatch(/^[0-9a-f]+$/); // salt hex
    expect(parts[2]).toMatch(/^[0-9a-f]+$/); // hash hex
  });

  it('salt aleatório: a mesma senha gera hashes diferentes', async () => {
    const a = await hashPassword('mesma-senha');
    const b = await hashPassword('mesma-senha');
    expect(a).not.toBe(b);
  });

  it('verifyPassword aceita a senha certa', async () => {
    const hash = await hashPassword('correta123');
    expect(await verifyPassword('correta123', hash)).toBe(true);
  });

  it('verifyPassword recusa a senha errada', async () => {
    const hash = await hashPassword('correta123');
    expect(await verifyPassword('errada', hash)).toBe(false);
  });

  it('verifyPassword recusa hash nulo/vazio/mal-formado sem estourar', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', undefined)).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'lixo')).toBe(false);
    expect(await verifyPassword('x', 'scrypt:soum_campo')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt:aa:bb')).toBe(false);
  });

  it('fakeVerify resolve sem lançar (anti-enumeração por timing)', async () => {
    await expect(fakeVerify('qualquer-coisa')).resolves.toBeUndefined();
  });
});

describe('password — token de sessão', () => {
  it('newSessionToken tem prefixo ps_ e hash = sha256(token)', () => {
    const { token, hash } = newSessionToken();
    expect(token.startsWith('ps_')).toBe(true);
    expect(hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(hash).toBe(hashSessionToken(token));
  });

  it('tokens de sessão são únicos a cada chamada', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it('isSessionToken distingue sessão (ps_) de token de acesso cru', () => {
    expect(isSessionToken('ps_abc123')).toBe(true);
    expect(isSessionToken('abc123deadbeef')).toBe(false); // token de acesso legado
    expect(isSessionToken('')).toBe(false);
  });
});
