import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

async function loadReplayRoute(poolMock: MockPool): Promise<(fastify: FastifyInstance) => Promise<void>> {
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
    Pool: vi.fn(function Pool() {
      return { query: poolMock.query, on: vi.fn(), end: vi.fn() };
    }),
  }));

  const module = await import('../../../src/admin/replay.route.js');
  return module.registerReplayRoute;
}

function createFastify(): FastifyInstance {
  const routes: Record<string, { preHandler?: unknown; handler: (req: unknown, reply: unknown) => Promise<unknown> }> = {};
  const fastify = {
    post: vi.fn((path: string, options: unknown, handler?: unknown) => {
      if (typeof options === 'function') {
        routes[path] = { handler: options as (req: unknown, reply: unknown) => Promise<unknown> };
      } else {
        const opts = options as { preHandler?: unknown; handler?: (req: unknown, reply: unknown) => Promise<unknown> };
        routes[path] = { preHandler: opts.preHandler, handler: opts.handler! };
      }
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

describe('registerReplayRoute', () => {
  afterEach(() => {
    vi.doUnmock('pg');
    vi.doUnmock('pino');
    vi.resetModules();
  });

  it('returns 401 without token', async () => {
    const poolMock: MockPool = { query: vi.fn() };
    const registerReplayRoute = await loadReplayRoute(poolMock);
    const fastify = createFastify();
    await registerReplayRoute(fastify);

    const route = fastify._routes['/admin/replay/:raw_event_id'];
    expect(route.preHandler).toBeDefined();

    const request = { headers: {}, params: { raw_event_id: '123' } };
    const reply = createReply();
    const done = vi.fn();

    if (typeof route.preHandler === 'function') {
      route.preHandler(request, reply, done);
    }

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: 'Unauthorized' });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it('returns 400 for non-numeric raw_event_id', async () => {
    const poolMock: MockPool = { query: vi.fn() };
    const registerReplayRoute = await loadReplayRoute(poolMock);
    const fastify = createFastify();
    await registerReplayRoute(fastify);

    const route = fastify._routes['/admin/replay/:raw_event_id'];
    const request = { headers: { authorization: 'Bearer test-admin-token' }, params: { raw_event_id: 'abc' } };
    const reply = createReply();

    await route.handler(request, reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: 'invalid raw_event_id' });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it('returns 400 for negative raw_event_id', async () => {
    const poolMock: MockPool = { query: vi.fn() };
    const registerReplayRoute = await loadReplayRoute(poolMock);
    const fastify = createFastify();
    await registerReplayRoute(fastify);

    const route = fastify._routes['/admin/replay/:raw_event_id'];
    const request = { headers: { authorization: 'Bearer test-admin-token' }, params: { raw_event_id: '-5' } };
    const reply = createReply();

    await route.handler(request, reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: 'invalid raw_event_id' });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it('returns 400 for zero raw_event_id', async () => {
    const poolMock: MockPool = { query: vi.fn() };
    const registerReplayRoute = await loadReplayRoute(poolMock);
    const fastify = createFastify();
    await registerReplayRoute(fastify);

    const route = fastify._routes['/admin/replay/:raw_event_id'];
    const request = { headers: { authorization: 'Bearer test-admin-token' }, params: { raw_event_id: '0' } };
    const reply = createReply();

    await route.handler(request, reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: 'invalid raw_event_id' });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it('returns 404 when raw_event does not exist', async () => {
    const poolMock: MockPool = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const registerReplayRoute = await loadReplayRoute(poolMock);
    const fastify = createFastify();
    await registerReplayRoute(fastify);

    const route = fastify._routes['/admin/replay/:raw_event_id'];
    const request = { headers: { authorization: 'Bearer test-admin-token' }, params: { raw_event_id: '999' } };
    const reply = createReply();

    await route.handler(request, reply);

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual({ error: 'not found' });
  });

  it('returns 200 with previous_status when raw_event was processed', async () => {
    const poolMock: MockPool = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [{ id: 42, previous_status: 'processed' }],
      }),
    };
    const registerReplayRoute = await loadReplayRoute(poolMock);
    const fastify = createFastify();
    await registerReplayRoute(fastify);

    const route = fastify._routes['/admin/replay/:raw_event_id'];
    const request = { headers: { authorization: 'Bearer test-admin-token' }, params: { raw_event_id: '42' } };
    const reply = createReply();

    await route.handler(request, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ replayed: true, raw_event_id: 42, previous_status: 'processed' });
  });

  it('returns 200 with previous_status pending when already pending', async () => {
    const poolMock: MockPool = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [{ id: 7, previous_status: 'pending' }],
      }),
    };
    const registerReplayRoute = await loadReplayRoute(poolMock);
    const fastify = createFastify();
    await registerReplayRoute(fastify);

    const route = fastify._routes['/admin/replay/:raw_event_id'];
    const request = { headers: { authorization: 'Bearer test-admin-token' }, params: { raw_event_id: '7' } };
    const reply = createReply();

    await route.handler(request, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ replayed: true, raw_event_id: 7, previous_status: 'pending' });
  });

  it('issues UPDATE that sets processing_status, processing_error and processed_at only', async () => {
    const poolMock: MockPool = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [{ id: 10, previous_status: 'failed' }],
      }),
    };
    const registerReplayRoute = await loadReplayRoute(poolMock);
    const fastify = createFastify();
    await registerReplayRoute(fastify);

    const route = fastify._routes['/admin/replay/:raw_event_id'];
    const request = { headers: { authorization: 'Bearer test-admin-token' }, params: { raw_event_id: '10' } };
    const reply = createReply();

    await route.handler(request, reply);

    const queryCall = poolMock.query.mock.calls[0] as [string, unknown[]];
    const sql = queryCall[0];

    expect(sql).toContain("SET processing_status = 'pending'");
    expect(sql).toContain('processing_error = NULL');
    expect(sql).toContain('processed_at = NULL');
    expect(sql).toContain('FOR UPDATE');

    expect(sql).not.toContain('payload');
    expect(sql).not.toContain('chatwoot_delivery_id');
    expect(sql).not.toContain('received_at');
    expect(sql).not.toContain('chatwoot_signature');
    expect(sql).not.toContain('chatwoot_timestamp');
    expect(sql).not.toContain('event_type');
    expect(sql).not.toContain('account_id');
  });
});
