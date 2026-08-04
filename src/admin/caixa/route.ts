import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import {
  rateLimitBlocked,
  rateLimitClear,
  rateLimitHit,
  rateLimitRetryAfterSeconds,
} from '../../shared/rate-limit.js';
import { registerCaixaStaticRoutes } from './route-static.js';
import {
  authenticateCaixa,
  changeCaixaPassword,
  isCaixaSessionToken,
  revokeCaixaSession,
  validateCaixaSession,
  type CaixaAuth,
} from './queries.js';
import { getCaixaSaleReceipt, getCaixaSales } from './sales.js';

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_PER_USER = 10;
const LOGIN_MAX_PER_IP = 20;

const loginSchema = z.object({
  username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),
  password: z.string().min(1).max(200),
});

const salesQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d']).default('today'),
  search: z.string().trim().max(80).default(''),
});

const receiptParamsSchema = z.object({ orderId: z.string().uuid() });

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(12).max(200),
}).refine((data) => data.current_password !== data.new_password, {
  message: 'same_password',
  path: ['new_password'],
});

type CaixaRequest = FastifyRequest & { caixa?: CaixaAuth };

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  return isCaixaSessionToken(token) ? token : null;
}

function tooMany(reply: FastifyReply, key: string) {
  return reply.header('Retry-After', String(rateLimitRetryAfterSeconds(key)))
    .status(429).send({ error: 'too_many_attempts' });
}

export async function registerCaixaRoute(fastify: FastifyInstance): Promise<void> {
  const flagGate = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!env.MATRIZ_CAIXA_PORTAL) await reply.status(404).send({ error: 'not_found' });
  };
  registerCaixaStaticRoutes(fastify, flagGate);

  const requireCaixaAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerOf(request);
    if (!token) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    const auth = await validateCaixaSession(env.FAREJADOR_ENV, token);
    if (!auth) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    (request as CaixaRequest).caixa = auth;
  };

  fastify.post('/api/caixa/login', { preHandler: flagGate }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ipKey = `caixa-login:ip:${request.ip}`;
    if (rateLimitBlocked(ipKey, LOGIN_MAX_PER_IP)) return tooMany(reply, ipKey);

    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const exceeded = rateLimitHit(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS);
      if (exceeded) return tooMany(reply, ipKey);
      return reply.status(401).send({ error: 'invalid_credentials' });
    }

    const userKey = `caixa-login:user:${parsed.data.username.toLowerCase()}`;
    if (rateLimitBlocked(userKey, LOGIN_MAX_PER_USER)) return tooMany(reply, userKey);
    const result = await authenticateCaixa(
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
    return reply.status(200).send(result);
  });

  fastify.get('/api/caixa/me', { preHandler: [flagGate, requireCaixaAuth] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const auth = (request as CaixaRequest).caixa!;
    return reply.status(200).send({ display_name: auth.displayName, username: auth.username });
  });

  fastify.get('/api/caixa/vendas', { preHandler: [flagGate, requireCaixaAuth] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = salesQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    const auth = (request as CaixaRequest).caixa!;
    const payload = await getCaixaSales(
      env.FAREJADOR_ENV,
      parsed.data.period,
      parsed.data.search,
    );
    return reply.status(200).send({ ...payload, operator_name: auth.displayName });
  });

  fastify.get('/api/caixa/vendas/:orderId/recibo', {
    preHandler: [flagGate, requireCaixaAuth],
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = receiptParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_order_id' });
    const receipt = await getCaixaSaleReceipt(env.FAREJADOR_ENV, parsed.data.orderId);
    if (!receipt) return reply.status(404).send({ error: 'sale_not_found' });
    return reply.status(200).send(receipt);
  });

  fastify.post('/api/caixa/password', { preHandler: [flagGate, requireCaixaAuth] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const auth = (request as CaixaRequest).caixa!;
    const attemptKey = `caixa-password:${auth.personId}:${request.ip}`;
    if (rateLimitBlocked(attemptKey, 5)) return tooMany(reply, attemptKey);
    const parsed = changePasswordSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    const result = await changeCaixaPassword(
      env.FAREJADOR_ENV,
      auth.personId,
      parsed.data.current_password,
      parsed.data.new_password,
    );
    if (result === 'invalid_current_password') {
      const exceeded = rateLimitHit(attemptKey, 5, LOGIN_WINDOW_MS);
      if (exceeded) return tooMany(reply, attemptKey);
      return reply.status(403).send({ error: result });
    }
    if (result === 'same_password') return reply.status(400).send({ error: result });
    if (result === 'account_not_found') return reply.status(404).send({ error: result });
    rateLimitClear(attemptKey);
    return reply.status(200).send({ ok: true });
  });

  fastify.post('/api/caixa/logout', { preHandler: [flagGate, requireCaixaAuth] }, async (request, reply) => {
    const token = bearerOf(request)!;
    await revokeCaixaSession(env.FAREJADOR_ENV, token);
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send({ ok: true });
  });
}
