import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  APP_COMMIT_SHA: 'a'.repeat(40),
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

async function loadHealthRoute(poolMock: MockPool): Promise<(fastify: FastifyInstance) => Promise<void>> {
  vi.resetModules();
  Object.assign(process.env, baseEnv);

  vi.doMock('pino', () => ({
    default: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  }));

  vi.doMock('pg', () => ({
    Pool: vi.fn(() => ({
      query: poolMock.query,
      on: vi.fn(),
      end: vi.fn(),
    })),
  }));

  const module = await import('../../../src/admin/health.route.js');
  return module.registerHealthRoute;
}

function createFastify(): FastifyInstance {
  const routes: Record<string, { handler: (req: unknown, reply: unknown) => Promise<unknown> }> = {};
  const fastify = {
    get: vi.fn((path: string, handler: (req: unknown, reply: unknown) => Promise<unknown>) => {
      routes[path] = { handler };
    }),
    _routes: routes,
  } as unknown as FastifyInstance & { _routes: typeof routes };
  return fastify;
}

function createReply(): {
  statusCode: number;
  payload: unknown;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    status: vi.fn(function status(this: typeof reply, code: number) {
      this.statusCode = code;
      return this;
    }),
    send: vi.fn(function send(this: typeof reply, payload: unknown) {
      this.payload = payload;
      return this;
    }),
  };
  return reply;
}

describe('registerHealthRoute', () => {
  afterEach(() => {
    vi.doUnmock('pg');
    vi.doUnmock('pino');
    vi.resetModules();
    vi.useRealTimers();
  });

  it('returns 200 ok when DB responds', async () => {
    const poolMock: MockPool = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    const registerHealthRoute = await loadHealthRoute(poolMock);
    const fastify = createFastify();
    await registerHealthRoute(fastify);

    const reply = createReply();
    await fastify._routes['/healthz'].handler({}, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ status: 'ok', commit: 'a'.repeat(40) });
  });

  it('returns 503 when DB rejects', async () => {
    const poolMock: MockPool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const registerHealthRoute = await loadHealthRoute(poolMock);
    const fastify = createFastify();
    await registerHealthRoute(fastify);

    const reply = createReply();
    await fastify._routes['/healthz'].handler({}, reply);

    expect(reply.statusCode).toBe(503);
    expect(reply.payload).toEqual({
      status: 'error',
      reason: 'database_unavailable',
      commit: 'a'.repeat(40),
    });
  });

  it('returns 503 when DB timeout exceeds 2s', async () => {
    const poolMock: MockPool = {
      query: vi.fn().mockImplementation(() => new Promise(() => {})),
    };
    const registerHealthRoute = await loadHealthRoute(poolMock);
    const fastify = createFastify();
    await registerHealthRoute(fastify);

    vi.useFakeTimers();
    const reply = createReply();
    const promise = fastify._routes['/healthz'].handler({}, reply);

    vi.advanceTimersByTime(2100);
    await promise;

    expect(reply.statusCode).toBe(503);
    expect(reply.payload).toEqual({
      status: 'error',
      reason: 'database_unavailable',
      commit: 'a'.repeat(40),
    });
  });
});
