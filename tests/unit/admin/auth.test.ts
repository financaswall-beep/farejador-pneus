import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'expected-admin-token',
  ADMIN_BEARER_FALLBACK_ENABLED: 'true',
};

function createRequest(authHeader?: string, ip = '203.0.113.10'): FastifyRequest {
  return {
    headers: authHeader ? { authorization: authHeader, host: 'example.test' } : { host: 'example.test' },
    ip,
    method: 'GET',
    protocol: 'https',
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function createReply(): FastifyReply & { payload: unknown; headers: Record<string, string> } {
  const reply = {
    statusCode: 200,
    sent: false,
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
      this.sent = true;
      return this;
    }),
  };
  return reply as unknown as FastifyReply & { payload: unknown; headers: Record<string, string> };
}

async function loadAuth() {
  vi.resetModules();
  Object.assign(process.env, baseEnv);
  return import('../../../src/admin/auth.js');
}

describe('requireAdminAuth', () => {
  afterEach(() => vi.resetModules());

  it.each([
    [undefined, 'missing'],
    ['Basic abc', 'not bearer'],
    ['Bearer short', 'different length'],
    ['Bearer expected-admin-XXXX', 'wrong content'],
  ])('returns 401 for %s (%s)', async (header) => {
    const { requireAdminAuth } = await loadAuth();
    const reply = createReply();

    await requireAdminAuth(createRequest(header), reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: 'Unauthorized' });
  });

  it('accepts the emergency bearer during transition and records its context', async () => {
    const { getAdminContext, requireAdminAuth } = await loadAuth();
    const request = createRequest('Bearer expected-admin-token');
    const reply = createReply();

    await requireAdminAuth(request, reply);

    expect(reply.statusCode).toBe(200);
    expect(getAdminContext(request)).toMatchObject({ authType: 'emergency', role: 'owner' });
  });

  it('returns 429 after 10 invalid attempts from the same IP', async () => {
    const { requireAdminAuth } = await loadAuth();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const reply = createReply();
      await requireAdminAuth(createRequest('Bearer wrong', '198.51.100.8'), reply);
      expect(reply.statusCode).toBe(401);
    }

    const blockedReply = createReply();
    await requireAdminAuth(createRequest('Bearer expected-admin-token', '198.51.100.8'), blockedReply);

    expect(blockedReply.statusCode).toBe(429);
    expect(blockedReply.payload).toEqual({ error: 'too_many_attempts' });
    expect(blockedReply.headers['Retry-After']).toBeDefined();
  });
});
