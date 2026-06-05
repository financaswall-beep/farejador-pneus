/**
 * Hash de senha e token de sessão do Portal Parceiro — Etapa P1 (login de verdade).
 *
 * Senha: scrypt (nativo do Node, sem dependência nova). O banco guarda só o hash,
 *   formato `scrypt:<saltHex>:<hashHex>` — a senha em texto nunca toca o banco.
 *   Verificação em tempo constante (timingSafeEqual) pra não vazar por timing.
 *
 * Sessão: token aleatório com prefixo `ps_`; o banco guarda só o sha256
 *   (hex) — MESMO esquema do token de acesso (network.hash_partner_token) e
 *   IDÊNTICO ao que network.validate_partner_session recalcula. O prefixo deixa
 *   o auth.ts rotear sessão x token de acesso sem um roundtrip extra no banco.
 */

import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';

// Parâmetros do scrypt. N=2^15 (cost) é o recomendado atual pra login interativo.
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

const SESSION_PREFIX = 'ps_';

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, SCRYPT_PARAMS, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** Gera o hash scrypt da senha pra guardar no banco. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Confere a senha contra o hash guardado. Tempo constante; false em qualquer formato inesperado. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await scryptAsync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Queima o mesmo tempo de um verifyPassword real, sem comparar nada. Chamado no
 * login quando o usuário NÃO existe, pra não vazar "usuário existe?" por timing.
 */
export async function fakeVerify(password: string): Promise<void> {
  await scryptAsync(password, randomBytes(16), SCRYPT_KEYLEN);
}

/** Cria um token de sessão novo (texto, devolvido UMA vez) + seu hash sha256 (guardado). */
export function newSessionToken(): { token: string; hash: string } {
  const token = SESSION_PREFIX + randomBytes(32).toString('hex');
  return { token, hash: hashSessionToken(token) };
}

/** sha256 hex do token de sessão — idêntico ao que validate_partner_session recalcula. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Um bearer é token de sessão (prefixo `ps_`) ou token de acesso legado (sem prefixo)? */
export function isSessionToken(bearer: string): boolean {
  return bearer.startsWith(SESSION_PREFIX);
}
