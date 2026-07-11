import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../shared/config/env.js';
import {
  rateLimitBlocked,
  rateLimitClear,
  rateLimitHit,
  rateLimitRetryAfterSeconds,
} from '../shared/rate-limit.js';
import { logger } from '../shared/logger.js';
import {
  extractAdminSessionCookie,
  getAdminContext,
  hasValidEmergencyAdminToken,
  requireAdminAuth,
  type AdminAuthedRequest,
} from './auth.js';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  MatrizAdminUsernameTakenError,
  MatrizOwnerAlreadyConfiguredError,
  authenticateMatrizAdmin,
  bootstrapMatrizOwner,
  hasMatrizOwner,
  revokeMatrizAdminSession,
  type MatrizAdminLoginResult,
} from './session.js';

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_PER_USER = 10;
const LOGIN_MAX_PER_IP = 20;
const BOOTSTRAP_MAX_PER_IP = 5;

const usernameField = z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/);
const loginSchema = z.object({ username: usernameField, password: z.string().min(1).max(200) });
const bootstrapSchema = z.object({
  display_name: z.string().trim().min(2).max(120),
  username: usernameField,
  password: z.string().min(12).max(200),
});

function cookieHeader(value: string, maxAge: number): string {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function setSessionCookie(reply: FastifyReply, sessionToken: string): void {
  reply.header('Set-Cookie', cookieHeader(sessionToken, ADMIN_SESSION_TTL_SECONDS));
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', cookieHeader('', 0));
}

function publicUser(result: MatrizAdminLoginResult) {
  return {
    display_name: result.context.displayName,
    username: result.context.username,
    role: result.context.role,
    expires_at: result.expiresAt,
  };
}

function tooMany(reply: FastifyReply, key: string) {
  return reply.header('Retry-After', String(rateLimitRetryAfterSeconds(key)))
    .status(429).send({ error: 'too_many_attempts' });
}

export async function registerAdminLoginRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/auth/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send({ bootstrap_required: !(await hasMatrizOwner()) });
  });

  fastify.post('/admin/api/auth/bootstrap', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const rateKey = `admin-bootstrap:${request.ip}`;
    if (rateLimitBlocked(rateKey, BOOTSTRAP_MAX_PER_IP)) return tooMany(reply, rateKey);
    if (!hasValidEmergencyAdminToken(request)) {
      const exceeded = rateLimitHit(rateKey, BOOTSTRAP_MAX_PER_IP, LOGIN_WINDOW_MS);
      if (exceeded) return tooMany(reply, rateKey);
      return reply.status(401).send({ error: 'invalid_emergency_token' });
    }
    const parsed = bootstrapSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      const result = await bootstrapMatrizOwner({
        displayName: parsed.data.display_name,
        username: parsed.data.username,
        password: parsed.data.password,
      });
      rateLimitClear(rateKey);
      rateLimitClear(`admin-auth:${request.ip}`);
      setSessionCookie(reply, result.sessionToken);
      return reply.status(201).send({ user: publicUser(result) });
    } catch (error) {
      if (error instanceof MatrizOwnerAlreadyConfiguredError) {
        return reply.status(409).send({ error: 'owner_already_configured' });
      }
      if (error instanceof MatrizAdminUsernameTakenError) {
        return reply.status(409).send({ error: 'username_taken' });
      }
      logger.error({ err: error }, 'admin owner bootstrap failed');
      return reply.status(500).send({ error: 'internal_server_error' });
    }
  });

  fastify.post('/admin/api/auth/login', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ipKey = `admin-login:ip:${request.ip}`;
    if (rateLimitBlocked(ipKey, LOGIN_MAX_PER_IP)) return tooMany(reply, ipKey);
    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const exceeded = rateLimitHit(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS);
      if (exceeded) return tooMany(reply, ipKey);
      return reply.status(401).send({ error: 'invalid_credentials' });
    }
    const userKey = `admin-login:user:${parsed.data.username.toLowerCase()}`;
    if (rateLimitBlocked(userKey, LOGIN_MAX_PER_USER)) return tooMany(reply, userKey);

    const result = await authenticateMatrizAdmin(
      env.FAREJADOR_ENV,
      parsed.data.username,
      parsed.data.password,
    );
    if (!result) {
      const ipExceeded = rateLimitHit(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS);
      const userExceeded = rateLimitHit(userKey, LOGIN_MAX_PER_USER, LOGIN_WINDOW_MS);
      if (ipExceeded || userExceeded) return tooMany(reply, userExceeded ? userKey : ipKey);
      return reply.status(401).send({ error: 'invalid_credentials' });
    }

    rateLimitClear(ipKey);
    rateLimitClear(userKey);
    rateLimitClear(`admin-auth:${request.ip}`);
    setSessionCookie(reply, result.sessionToken);
    return reply.status(200).send({ user: publicUser(result) });
  });

  fastify.get('/admin/api/auth/me', { preHandler: requireAdminAuth }, async (request: AdminAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const context = getAdminContext(request);
    return reply.status(200).send({
      user: {
        display_name: context.displayName,
        username: context.username,
        role: context.role,
        auth_type: context.authType,
      },
    });
  });

  fastify.post('/admin/api/auth/logout', { preHandler: requireAdminAuth }, async (request, reply) => {
    const sessionToken = extractAdminSessionCookie(request);
    if (sessionToken) await revokeMatrizAdminSession(env.FAREJADOR_ENV, sessionToken);
    clearSessionCookie(reply);
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send({ ok: true });
  });
}
