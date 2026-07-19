import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';

export interface RequestContextValue {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContextValue>();

export function normalizeRequestIdHeader(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  if (!candidate || candidate.length > 128) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(candidate) ? candidate : undefined;
}

export function createRequestId(request: { headers: IncomingHttpHeaders }): string {
  return normalizeRequestIdHeader(request.headers['x-request-id']) ?? randomUUID();
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function registerRequestContext(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header('X-Request-ID', request.id);
    requestContext.run({ requestId: request.id }, done);
  });
}
