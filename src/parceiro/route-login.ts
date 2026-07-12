// P1 — Login do parceiro por usuário+senha (PÚBLICO; a porta de entrada do painel).
// Extraído de route.ts em 2026-07-12 (teto congelado da obra 300: o hardening de
// 07-10 — throttle por USUÁRIO e por IP com Retry-After — engordou o arquivo além
// do teto). Comportamento IDÊNTICO ao pré-corte; os schemas continuam morando no
// route.ts (fonte única dos campos de credencial) e entram por injeção.
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  rateLimitBlocked,
  rateLimitClear,
  rateLimitHit,
  rateLimitRetryAfterSeconds,
} from '../shared/rate-limit.js';
import { authenticatePartnerLogin } from './queries.js';
import { env } from '../shared/config/env.js';

// Login/1º acesso: até 10 falhas por usuário e 20 por IP em 5 min.
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_MAX_PER_IP = 20;
export const LOGIN_WINDOW_MS = 5 * 60 * 1000;

interface LoginRouteSchemas {
  paramsSchema: z.ZodType<{ slug: string }>;
  loginSchema: z.ZodType<{ username: string; password: string }>;
}

/** Devolve um token de SESSÃO que o front guarda e usa como Bearer. Resposta
 *  única pra usuário inexistente e senha errada (não revela qual). */
export function registerParceiroLoginRoute(
  fastify: FastifyInstance,
  { paramsSchema, loginSchema }: LoginRouteSchemas,
): void {
  fastify.post('/parceiro/:slug/api/login', async (request, reply) => {
    const ipKey = `login:ip:${request.ip}`;
    if (rateLimitBlocked(ipKey, LOGIN_MAX_PER_IP)) {
      return reply.header('Retry-After', String(rateLimitRetryAfterSeconds(ipKey))).status(429).send({ error: 'too_many_attempts' });
    }
    const params = paramsSchema.safeParse(request.params);
    // Slug malformado/inexistente devolve a MESMA resposta de credencial inválida
    // (não revela quais slugs existem).
    if (!params.success) {
      const exceeded = rateLimitHit(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS);
      if (exceeded) return reply.header('Retry-After', String(rateLimitRetryAfterSeconds(ipKey))).status(429).send({ error: 'too_many_attempts' });
      return reply.status(401).send({ error: 'invalid_credentials' });
    }
    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const exceeded = rateLimitHit(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS);
      if (exceeded) return reply.header('Retry-After', String(rateLimitRetryAfterSeconds(ipKey))).status(429).send({ error: 'too_many_attempts' });
      return reply.status(401).send({ error: 'invalid_credentials' });
    }
    const userKey = `login:user:${params.data.slug}:${parsed.data.username.toLowerCase()}`;
    if (rateLimitBlocked(userKey, LOGIN_MAX_ATTEMPTS)) {
      return reply.header('Retry-After', String(rateLimitRetryAfterSeconds(userKey))).status(429).send({ error: 'too_many_attempts' });
    }
    const result = await authenticatePartnerLogin(env.FAREJADOR_ENV, params.data.slug, parsed.data.username, parsed.data.password);
    if (!result) {
      const ipExceeded = rateLimitHit(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS);
      const userExceeded = rateLimitHit(userKey, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS);
      if (ipExceeded || userExceeded) {
        const retryKey = userExceeded ? userKey : ipKey;
        return reply.header('Retry-After', String(rateLimitRetryAfterSeconds(retryKey))).status(429).send({ error: 'too_many_attempts' });
      }
      return reply.status(401).send({ error: 'invalid_credentials' });
    }
    rateLimitClear(ipKey);
    rateLimitClear(userKey);
    return reply.status(200).send(result);
  });
}
