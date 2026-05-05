import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

async function loadReconcileRoute(
  reconcileMock: ReturnType<typeof vi.fn>,
  reconcileAtendenteJobsMock: ReturnType<typeof vi.fn> = vi.fn(),
) {
  vi.resetModules();
  Object.assign(process.env, baseEnv);
  vi.doMock('pino', () => ({
    default: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  }));
  vi.doMock('../../../src/admin/reconcile.service.js', () => ({
    reconcile: reconcileMock,
  }));
  vi.doMock('../../../src/atendente/reconcile-jobs.js', () => ({
    reconcileMissingAtendenteJobsWithPool: reconcileAtendenteJobsMock,
  }));

  return import('../../../src/admin/reconcile.route.js');
}

function createFastify(): FastifyInstance {
  const routes: Record<string, { preHandler?: unknown; handler: (req: unknown, reply: unknown) => Promise<unknown> }> = {};
  const fastify = {
    post: vi.fn((path: string, options: { preHandler?: unknown; handler: (req: unknown, reply: unknown) => Promise<unknown> }) => {
      routes[path] = { preHandler: options.preHandler, handler: options.handler };
    }),
    _routes: routes,
  } as unknown as FastifyInstance & { _routes: typeof routes };
  return fastify;
}

function createReply() {
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

describe('registerReconcileRoute', () => {
  afterEach(() => {
    vi.doUnmock('pino');
    vi.doUnmock('../../../src/admin/reconcile.service.js');
    vi.doUnmock('../../../src/atendente/reconcile-jobs.js');
    vi.resetModules();
  });

  it('returns 401 without token before calling the service', async () => {
    const reconcileMock = vi.fn();
    const { registerReconcileRoute } = await loadReconcileRoute(reconcileMock);
    const fastify = createFastify();
    await registerReconcileRoute(fastify);
    const route = fastify._routes['/admin/reconcile'];
    const reply = createReply();
    const done = vi.fn();

    if (typeof route.preHandler === 'function') {
      route.preHandler({ headers: {}, body: {} }, reply, done);
    }

    expect(reply.statusCode).toBe(401);
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it('returns 400 when since is missing', async () => {
    const reconcileMock = vi.fn();
    const { registerReconcileRoute } = await loadReconcileRoute(reconcileMock);
    const fastify = createFastify();
    await registerReconcileRoute(fastify);
    const reply = createReply();

    await fastify._routes['/admin/reconcile'].handler(
      { body: { until: '2026-04-24T00:00:00Z' } },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it('returns 400 when since is not before until', async () => {
    const reconcileMock = vi.fn();
    const { registerReconcileRoute } = await loadReconcileRoute(reconcileMock);
    const fastify = createFastify();
    await registerReconcileRoute(fastify);
    const reply = createReply();

    await fastify._routes['/admin/reconcile'].handler(
      {
        body: {
          since: '2026-04-24T00:00:00Z',
          until: '2026-04-24T00:00:00Z',
        },
      },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: 'since must be before until' });
  });

  it('returns 400 when the reconcile window is larger than 7 days', async () => {
    const reconcileMock = vi.fn();
    const { registerReconcileRoute } = await loadReconcileRoute(reconcileMock);
    const fastify = createFastify();
    await registerReconcileRoute(fastify);
    const reply = createReply();

    await fastify._routes['/admin/reconcile'].handler(
      {
        body: {
          since: '2026-04-01T00:00:00Z',
          until: '2026-04-10T00:00:00Z',
        },
      },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: 'window too large, max 7 days' });
  });

  it('returns 200 with reconcile counters for a valid body', async () => {
    const result = {
      inserted: 1,
      skipped_duplicate: 2,
      errors: [],
      pages_fetched: 1,
      aborted: false,
      abort_reason: null,
    };
    const reconcileMock = vi.fn().mockResolvedValue(result);
    const { registerReconcileRoute } = await loadReconcileRoute(reconcileMock);
    const fastify = createFastify();
    await registerReconcileRoute(fastify);
    const reply = createReply();

    await fastify._routes['/admin/reconcile'].handler(
      {
        body: {
          since: '2026-04-20T00:00:00Z',
          until: '2026-04-24T00:00:00Z',
        },
      },
      reply,
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual(result);
    expect(reconcileMock).toHaveBeenCalledWith({
      since: new Date('2026-04-20T00:00:00Z'),
      until: new Date('2026-04-24T00:00:00Z'),
      environment: 'prod',
    });
  });

  it('returns 502 when the Chatwoot API is unavailable', async () => {
    vi.resetModules();
    Object.assign(process.env, baseEnv);
    const { ChatwootApiError } = await import('../../../src/admin/chatwoot-api.client.js');
    const reconcileMock = vi.fn().mockRejectedValue(new ChatwootApiError('upstream failed', 500));
    const { registerReconcileRoute } = await loadReconcileRoute(reconcileMock);
    const fastify = createFastify();
    await registerReconcileRoute(fastify);
    const reply = createReply();

    await fastify._routes['/admin/reconcile'].handler(
      {
        body: {
          since: '2026-04-20T00:00:00Z',
          until: '2026-04-24T00:00:00Z',
        },
      },
      reply,
    );

    expect(reply.statusCode).toBe(502);
    expect(reply.payload).toEqual({ error: 'chatwoot_api_unavailable' });
  });

  it('returns 200 with atendente job reconciliation counters', async () => {
    const result = {
      candidates: 2,
      reconciled: 2,
      jobs: [
        {
          conversation_id: 'conversation-1',
          trigger_message_id: 'message-1',
          atendente_job_id: 'job-1',
          agent_session_id: 'session-1',
        },
      ],
    };
    const reconcileMock = vi.fn();
    const reconcileAtendenteJobsMock = vi.fn().mockResolvedValue(result);
    const { registerReconcileRoute } = await loadReconcileRoute(reconcileMock, reconcileAtendenteJobsMock);
    const fastify = createFastify();
    await registerReconcileRoute(fastify);
    const reply = createReply();

    await fastify._routes['/admin/reconcile/atendente-jobs'].handler(
      {
        body: {
          since: '2026-05-05T00:00:00Z',
          until: '2026-05-05T12:00:00Z',
          limit: 50,
        },
      },
      reply,
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual(result);
    expect(reconcileAtendenteJobsMock).toHaveBeenCalledWith({
      since: new Date('2026-05-05T00:00:00Z'),
      until: new Date('2026-05-05T12:00:00Z'),
      environment: 'prod',
      limit: 50,
    });
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it('returns 400 when atendente jobs reconciliation limit is too large', async () => {
    const reconcileAtendenteJobsMock = vi.fn();
    const { registerReconcileRoute } = await loadReconcileRoute(vi.fn(), reconcileAtendenteJobsMock);
    const fastify = createFastify();
    await registerReconcileRoute(fastify);
    const reply = createReply();

    await fastify._routes['/admin/reconcile/atendente-jobs'].handler(
      {
        body: {
          since: '2026-05-05T00:00:00Z',
          until: '2026-05-05T12:00:00Z',
          limit: 501,
        },
      },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    expect(reconcileAtendenteJobsMock).not.toHaveBeenCalled();
  });
});
