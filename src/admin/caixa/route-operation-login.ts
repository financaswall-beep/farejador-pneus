import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import {
  rateLimitBlocked,
  rateLimitClear,
  rateLimitHit,
  rateLimitRetryAfterSeconds,
} from '../../shared/rate-limit.js';
import { mintPartnerSession } from '../../parceiro/queries.js';
import { authenticateCaixa, mintCaixaSessionForPerson } from './queries.js';
import {
  authenticateOperation,
  publicOperationWorkplace,
  type OperationWorkplace,
} from './operation-auth.js';
import {
  consumeOperationLoginTicket,
  newOperationLoginTicket,
} from './operation-login-ticket.js';

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_PER_USER = 10;
const LOGIN_MAX_PER_IP = 20;

const loginSchema = z.object({
  username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),
  password: z.string().min(1).max(200),
});

const workplaceSchema = z.object({
  ticket: z.string().regex(/^ot_[a-f0-9]{64}$/),
  workplace_id: z.string().min(1).max(100).regex(/^(matrix|partner:[a-z0-9-]+)$/),
});

function tooMany(reply: FastifyReply, key: string) {
  return reply.header('Retry-After', String(rateLimitRetryAfterSeconds(key)))
    .status(429).send({ error: 'too_many_attempts' });
}

async function issueOperationSession(
  environment: 'prod' | 'test',
  personId: string,
  workplace: OperationWorkplace,
) {
  if (workplace.kind === 'matrix') {
    const session = await mintCaixaSessionForPerson(environment, personId);
    if (!session) return null;
    return {
      mode: 'direct' as const,
      scope: 'matrix' as const,
      workplace_id: workplace.id,
      store_name: workplace.name,
      ...session,
    };
  }
  const session = await mintPartnerSession(environment, workplace.tokenId);
  return {
    mode: 'direct' as const,
    scope: 'partner' as const,
    workplace_id: workplace.id,
    slug: workplace.slug,
    store_name: workplace.name,
    role: workplace.role,
    redirect_path: `/parceiro/${workplace.slug}/`,
    ...session,
  };
}

export function registerCaixaOperationLoginRoutes(
  fastify: FastifyInstance,
  flagGate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
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
    if (env.OPERACAO_LOJA_PORTAL) {
      const operation = await authenticateOperation(
        env.FAREJADOR_ENV,
        parsed.data.username,
        parsed.data.password,
      );
      if (!operation) {
        const ipExceeded = rateLimitHit(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS);
        const userExceeded = rateLimitHit(userKey, LOGIN_MAX_PER_USER, LOGIN_WINDOW_MS);
        if (ipExceeded || userExceeded) return tooMany(reply, userExceeded ? userKey : ipKey);
        return reply.status(401).send({ error: 'invalid_credentials' });
      }

      rateLimitClear(ipKey);
      rateLimitClear(userKey);
      if (operation.workplaces.length === 1) {
        const result = await issueOperationSession(
          env.FAREJADOR_ENV,
          operation.personId,
          operation.workplaces[0]!,
        );
        if (!result) return reply.status(401).send({ error: 'invalid_credentials' });
        return reply.status(200).send(result);
      }

      const ticket = newOperationLoginTicket(
        env.FAREJADOR_ENV,
        operation.personId,
        operation.username,
        operation.workplaces,
      );
      return reply.status(200).send({
        mode: 'choose',
        ticket,
        workplaces: operation.workplaces.map(publicOperationWorkplace),
      });
    }

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

  fastify.post('/api/caixa/login/escolher', { preHandler: flagGate }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!env.OPERACAO_LOJA_PORTAL) return reply.status(404).send({ error: 'not_found' });
    const ipKey = `caixa-login:ip:${request.ip}`;
    if (rateLimitBlocked(ipKey, LOGIN_MAX_PER_IP)) return tooMany(reply, ipKey);
    const parsed = workplaceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const exceeded = rateLimitHit(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS);
      if (exceeded) return tooMany(reply, ipKey);
      return reply.status(401).send({ error: 'ticket_invalid' });
    }

    const ticket = consumeOperationLoginTicket(parsed.data.ticket);
    if (!ticket || ticket.environment !== env.FAREJADOR_ENV) {
      return reply.status(401).send({ error: 'ticket_invalid' });
    }
    const workplace = ticket.workplaces.find((item) => item.id === parsed.data.workplace_id);
    if (!workplace) return reply.status(401).send({ error: 'ticket_invalid' });
    const result = await issueOperationSession(env.FAREJADOR_ENV, ticket.personId, workplace);
    if (!result) return reply.status(401).send({ error: 'ticket_invalid' });
    rateLimitClear(ipKey);
    return reply.status(200).send(result);
  });
}
