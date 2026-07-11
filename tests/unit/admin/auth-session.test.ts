import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const validateSession = vi.fn();

function request(method = 'GET', origin?: string): FastifyRequest {
  return {
    headers: {
      cookie: `farejador_matriz_session=ms_${'a'.repeat(64)}`,
      host: 'farejador.example',
      ...(origin ? { origin } : {}),
    },
    method,
    protocol: 'https',
    ip: '203.0.113.4',
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function reply(): FastifyReply & { payload: unknown } {
  const value = {
    statusCode: 200, sent: false, payload: undefined as unknown,
    header: vi.fn(function header() { return value; }),
    status: vi.fn(function status(code: number) { value.statusCode = code; return value; }),
    send: vi.fn(function send(payload: unknown) { value.payload = payload; value.sent = true; return value; }),
  };
  return value as unknown as FastifyReply & { payload: unknown };
}

async function loadAuth(role: 'owner' | 'admin' = 'owner') {
  vi.resetModules();
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'prod', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    ADMIN_BEARER_FALLBACK_ENABLED: 'false',
  });
  validateSession.mockResolvedValue({
    authType: 'session', personId: 'p1', collaboratorId: 'c1', displayName: 'Wallace',
    username: 'wallace.matriz', role,
  });
  vi.doMock('../../../src/admin/session.js', () => ({
    ADMIN_SESSION_COOKIE: 'farejador_matriz_session',
    validateMatrizAdminSession: validateSession,
  }));
  return import('../../../src/admin/auth.js');
}

afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe('admin cookie guard', () => {
  it('accepts a valid HttpOnly-session token on reads', async () => {
    const auth = await loadAuth();
    const req = request(); const rep = reply();
    await auth.requireAdminAuth(req, rep);
    expect(rep.statusCode).toBe(200);
    expect(auth.getAdminContext(req).username).toBe('wallace.matriz');
  });

  it('rejects cookie-authenticated writes without same-origin evidence', async () => {
    const auth = await loadAuth();
    const rep = reply();
    await auth.requireAdminAuth(request('POST'), rep);
    expect(rep.statusCode).toBe(403);
    expect(rep.payload).toEqual({ error: 'csrf_rejected' });
  });

  it('accepts cookie-authenticated writes from the exact origin', async () => {
    const auth = await loadAuth();
    const rep = reply();
    await auth.requireAdminAuth(request('POST', 'https://farejador.example'), rep);
    expect(rep.statusCode).toBe(200);
  });

  it('keeps collaborator administration owner-only', async () => {
    const auth = await loadAuth('admin');
    const rep = reply();
    await auth.requireAdminOwner(request(), rep);
    expect(rep.statusCode).toBe(403);
    expect(rep.payload).toEqual({ error: 'admin_owner_required' });
  });
});
