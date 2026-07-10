import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { env } from '../shared/config/env.js';
import {
  rateLimitBlocked,
  rateLimitClear,
  rateLimitHit,
  rateLimitRetryAfterSeconds,
} from '../shared/rate-limit.js';

const ADMIN_AUTH_MAX_ATTEMPTS = 10;
const ADMIN_AUTH_WINDOW_MS = 5 * 60 * 1000;

function rejectAdminAuth(request: FastifyRequest, reply: FastifyReply, key: string): void {
  const exceeded = rateLimitHit(key, ADMIN_AUTH_MAX_ATTEMPTS, ADMIN_AUTH_WINDOW_MS);
  if (exceeded) {
    void reply
      .header('Retry-After', String(rateLimitRetryAfterSeconds(key)))
      .status(429)
      .send({ error: 'too_many_attempts' });
    return;
  }
  request.log?.warn({ ip: request.ip }, 'admin auth rejected');
  void reply.status(401).send({ error: 'Unauthorized' });
}

export function requireAdminAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  const rateKey = `admin-auth:${request.ip || 'unknown'}`;
  if (rateLimitBlocked(rateKey, ADMIN_AUTH_MAX_ATTEMPTS)) {
    void reply
      .header('Retry-After', String(rateLimitRetryAfterSeconds(rateKey)))
      .status(429)
      .send({ error: 'too_many_attempts' });
    return;
  }

  const header = request.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    rejectAdminAuth(request, reply, rateKey);
    return;
  }

  const receivedToken = header.slice(7);
  const expectedToken = env.ADMIN_AUTH_TOKEN;

  const receivedBuf = Buffer.from(receivedToken, 'utf-8');
  const expectedBuf = Buffer.from(expectedToken, 'utf-8');

  if (receivedBuf.length !== expectedBuf.length) {
    // Timing-safe comparison against itself to avoid leaking length difference
    void timingSafeEqual(receivedBuf, receivedBuf);
    rejectAdminAuth(request, reply, rateKey);
    return;
  }

  const isEqual = timingSafeEqual(receivedBuf, expectedBuf);

  if (!isEqual) {
    rejectAdminAuth(request, reply, rateKey);
    return;
  }

  rateLimitClear(rateKey);
  done();
}
