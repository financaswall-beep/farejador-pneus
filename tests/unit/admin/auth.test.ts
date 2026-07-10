import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'expected-admin-token',
};

function createRequest(authHeader?: string, ip = '203.0.113.10'): FastifyRequest {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
    ip,
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function createReply(): FastifyReply {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    headers: {} as Record<string, string>,
    header: vi.fn(function header(this: typeof reply, name: string, value: string) {
      this.headers[name] = value;
      return this;
    }),
    status: vi.fn(function status(this: typeof reply, code: number) {
      this.statusCode = code;
      return this;
    }),
    send: vi.fn(function send(this: typeof reply, payload: unknown) {
      this.payload = payload;
      return this;
    }),
  };
  return reply as unknown as FastifyReply;
}

async function loadAuth(): Promise<(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
) => void> {
  vi.resetModules();
  Object.assign(process.env, baseEnv);
  const module = await import('../../../src/admin/auth.js');
  return module.requireAdminAuth;
}

describe('requireAdminAuth', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns 401 when header is missing', async () => {
    const requireAdminAuth = await loadAuth();
    const request = createRequest();
    const reply = createReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    requireAdminAuth(request, reply, done);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: 'Unauthorized' });
    expect(done).not.toHaveBeenCalled();
  });

  it('returns 401 when header does not start with Bearer ', async () => {
    const requireAdminAuth = await loadAuth();
    const request = createRequest('Basic abc');
    const reply = createReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    requireAdminAuth(request, reply, done);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: 'Unauthorized' });
    expect(done).not.toHaveBeenCalled();
  });

  it('returns 401 when token has different length without throwing', async () => {
    const requireAdminAuth = await loadAuth();
    const request = createRequest('Bearer short');
    const reply = createReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    expect(() => requireAdminAuth(request, reply, done)).not.toThrow();
    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: 'Unauthorized' });
    expect(done).not.toHaveBeenCalled();
  });

  it('returns 401 when token has same length but wrong content', async () => {
    const requireAdminAuth = await loadAuth();
    const request = createRequest('Bearer expected-admin-XXXX');
    const reply = createReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    requireAdminAuth(request, reply, done);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: 'Unauthorized' });
    expect(done).not.toHaveBeenCalled();
  });

  it('calls done when token is correct', async () => {
    const requireAdminAuth = await loadAuth();
    const request = createRequest('Bearer expected-admin-token');
    const reply = createReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    requireAdminAuth(request, reply, done);

    expect(reply.statusCode).toBe(200);
    expect(done).toHaveBeenCalledOnce();
  });

  it('returns 429 after 10 invalid attempts from the same IP', async () => {
    const requireAdminAuth = await loadAuth();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const reply = createReply();
      requireAdminAuth(createRequest('Bearer wrong', '198.51.100.8'), reply, done);
      expect(reply.statusCode).toBe(401);
    }

    const blockedReply = createReply();
    requireAdminAuth(createRequest('Bearer expected-admin-token', '198.51.100.8'), blockedReply, done);

    expect(blockedReply.statusCode).toBe(429);
    expect(blockedReply.payload).toEqual({ error: 'too_many_attempts' });
    expect(blockedReply.headers['Retry-After']).toBeDefined();
    expect(done).not.toHaveBeenCalled();
  });
});
