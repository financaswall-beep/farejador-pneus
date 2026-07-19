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

async function loadHealthRoute(
  poolMock: MockPool,
  partnerPoolMock: MockPool = poolMock,
): Promise<(fastify: FastifyInstance) => Promise<void>> {
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

  vi.doMock('../../../src/parceiro/db.js', () => ({ partnerPool: partnerPoolMock }));

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
    vi.doUnmock('../../../src/parceiro/db.js');
    vi.resetModules();
    vi.useRealTimers();
  });

  it('livez retorna 200 sem consultar nenhum banco', async () => {
    const poolMock: MockPool = { query: vi.fn() };
    const partnerPoolMock: MockPool = { query: vi.fn() };
    const registerHealthRoute = await loadHealthRoute(poolMock, partnerPoolMock);
    const fastify = createFastify();
    await registerHealthRoute(fastify);

    const reply = createReply();
    await fastify._routes['/livez'].handler({ id: 'live-1' }, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ status: 'ok', commit: 'a'.repeat(40) });
    expect(poolMock.query).not.toHaveBeenCalled();
    expect(partnerPoolMock.query).not.toHaveBeenCalled();
  });

  it('readyz retorna 200 somente quando os dois bancos respondem', async () => {
    const poolMock: MockPool = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    const partnerPoolMock: MockPool = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    const registerHealthRoute = await loadHealthRoute(poolMock, partnerPoolMock);
    const fastify = createFastify();
    await registerHealthRoute(fastify);

    const reply = createReply();
    await fastify._routes['/readyz'].handler({ id: 'ready-1' }, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({
      status: 'ok',
      checks: { database: 'ok', partner_database: 'ok' },
      commit: 'a'.repeat(40),
    });
    expect(poolMock.query).toHaveBeenCalledWith('SELECT 1');
    expect(partnerPoolMock.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('readyz retorna 503 e identifica o banco indisponivel', async () => {
    const poolMock: MockPool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const partnerPoolMock: MockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const registerHealthRoute = await loadHealthRoute(poolMock, partnerPoolMock);
    const fastify = createFastify();
    await registerHealthRoute(fastify);

    const reply = createReply();
    await fastify._routes['/readyz'].handler({ id: 'ready-2' }, reply);

    expect(reply.statusCode).toBe(503);
    expect(reply.payload).toEqual({
      status: 'error',
      reason: 'dependency_unavailable',
      checks: { database: 'error', partner_database: 'ok' },
      commit: 'a'.repeat(40),
    });
  });

  it('healthz preserva compatibilidade como alias da prontidao', async () => {
    const poolMock: MockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const registerHealthRoute = await loadHealthRoute(poolMock);
    const fastify = createFastify();
    await registerHealthRoute(fastify);

    const reply = createReply();
    await fastify._routes['/healthz'].handler({ id: 'legacy-1' }, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toMatchObject({
      status: 'ok',
      checks: { database: 'ok', partner_database: 'ok' },
    });
  });

  it('readyz retorna 503 quando um check excede 2s', async () => {
    const poolMock: MockPool = {
      query: vi.fn().mockImplementation(() => new Promise(() => {})),
    };
    const partnerPoolMock: MockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const registerHealthRoute = await loadHealthRoute(poolMock, partnerPoolMock);
    const fastify = createFastify();
    await registerHealthRoute(fastify);

    vi.useFakeTimers();
    const reply = createReply();
    const promise = fastify._routes['/readyz'].handler({ id: 'ready-timeout' }, reply);

    await vi.advanceTimersByTimeAsync(2100);
    await promise;

    expect(reply.statusCode).toBe(503);
    expect(reply.payload).toEqual({
      status: 'error',
      reason: 'dependency_unavailable',
      checks: { database: 'error', partner_database: 'ok' },
      commit: 'a'.repeat(40),
    });
  });
});
