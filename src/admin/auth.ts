import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../shared/config/env.js';
import {
  rateLimitBlocked,
  rateLimitClear,
  rateLimitHit,
  rateLimitRetryAfterSeconds,
} from '../shared/rate-limit.js';
import {
  ADMIN_SESSION_COOKIE,
  type MatrizAdminContext,
  validateMatrizAdminSession,
} from './session.js';

const ADMIN_AUTH_MAX_ATTEMPTS = 10;
const ADMIN_AUTH_WINDOW_MS = 5 * 60 * 1000;

export interface AdminAuthedRequest extends FastifyRequest {
  adminContext?: MatrizAdminContext;
}

function parseCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string' || header.length > 8192) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try { return decodeURIComponent(value); } catch { return null; }
  }
  return null;
}

export function extractAdminSessionCookie(request: FastifyRequest): string | null {
  return parseCookie(request.headers.cookie, ADMIN_SESSION_COOKIE);
}

function tokenMatches(receivedToken: string, expectedToken: string): boolean {
  const received = Buffer.from(receivedToken, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (received.length !== expected.length) {
    void timingSafeEqual(received, received);
    return false;
  }
  return timingSafeEqual(received, expected);
}

export function hasValidEmergencyAdminToken(request: FastifyRequest): boolean {
  if (!env.ADMIN_BEARER_FALLBACK_ENABLED) return false;
  const header = request.headers.authorization;
  return typeof header === 'string'
    && header.startsWith('Bearer ')
    && tokenMatches(header.slice(7), env.ADMIN_AUTH_TOKEN);
}

function isSafeMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function isSameOriginBrowserWrite(request: FastifyRequest): boolean {
  if (isSafeMethod(request.method)) return true;
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin === 'string' && typeof host === 'string') {
    return origin === `${request.protocol}://${host}`;
  }
  return request.headers['sec-fetch-site'] === 'same-origin';
}

async function rejectAdminAuth(request: FastifyRequest, reply: FastifyReply, key: string): Promise<void> {
  const exceeded = rateLimitHit(key, ADMIN_AUTH_MAX_ATTEMPTS, ADMIN_AUTH_WINDOW_MS);
  if (exceeded) {
    await reply
      .header('Retry-After', String(rateLimitRetryAfterSeconds(key)))
      .status(429)
      .send({ error: 'too_many_attempts' });
    return;
  }
  request.log?.warn({ ip: request.ip }, 'admin auth rejected');
  await reply.status(401).send({ error: 'Unauthorized' });
}

export function getAdminContext(request: FastifyRequest): MatrizAdminContext {
  const context = (request as AdminAuthedRequest).adminContext;
  if (!context) throw new Error('admin_context_missing');
  return context;
}

export async function requireAdminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rateKey = `admin-auth:${request.ip || 'unknown'}`;
  if (rateLimitBlocked(rateKey, ADMIN_AUTH_MAX_ATTEMPTS)) {
    await reply
      .header('Retry-After', String(rateLimitRetryAfterSeconds(rateKey)))
      .status(429)
      .send({ error: 'too_many_attempts' });
    return;
  }

  if (hasValidEmergencyAdminToken(request)) {
    (request as AdminAuthedRequest).adminContext = {
      authType: 'emergency',
      personId: null,
      collaboratorId: null,
      displayName: 'Administrador emergencial',
      username: null,
      role: 'owner',
    };
    rateLimitClear(rateKey);
    return;
  }

  const sessionToken = extractAdminSessionCookie(request);
  if (sessionToken) {
    const context = await validateMatrizAdminSession(env.FAREJADOR_ENV, sessionToken);
    if (context) {
      if (!isSameOriginBrowserWrite(request)) {
        await reply.status(403).send({ error: 'csrf_rejected' });
        return;
      }
      (request as AdminAuthedRequest).adminContext = context;
      rateLimitClear(rateKey);
      return;
    }
  }

  // Abrir /admin/login ou consultar /auth/me sem credencial não é tentativa de
  // adivinhar segredo. Só credenciais apresentadas e inválidas consomem o limite.
  if (!sessionToken && typeof request.headers.authorization !== 'string') {
    await reply.status(401).send({ error: 'Unauthorized' });
    return;
  }

  await rejectAdminAuth(request, reply, rateKey);
}

export async function requireAdminOwner(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAdminAuth(request, reply);
  if (reply.sent) return;
  if (getAdminContext(request).role !== 'owner') {
    await reply.status(403).send({ error: 'admin_owner_required' });
  }
}
