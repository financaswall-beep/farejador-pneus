import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authenticate = vi.fn();
const hasOwner = vi.fn();

async function app() {
  vi.resetModules();
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'prod', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    ADMIN_BEARER_FALLBACK_ENABLED: 'true',
  });
  vi.doMock('../../../src/admin/session.js', () => {
    class OwnerConfigured extends Error {}
    class UsernameTaken extends Error {}
    return {
      ADMIN_SESSION_COOKIE: 'farejador_matriz_session',
      ADMIN_SESSION_TTL_SECONDS: 43_200,
      MatrizAdminUsernameTakenError: UsernameTaken,
      MatrizOwnerAlreadyConfiguredError: OwnerConfigured,
      authenticateMatrizAdmin: authenticate,
      bootstrapMatrizOwner: vi.fn(),
      hasMatrizOwner: hasOwner,
      revokeMatrizAdminSession: vi.fn(),
      validateMatrizAdminSession: vi.fn(),
    };
  });
  const fastify = Fastify();
  const { registerAdminLoginRoute } = await import('../../../src/admin/login.route.js');
  await registerAdminLoginRoute(fastify);
  return fastify;
}

afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe('admin login route', () => {
  it('sets the opaque session only in an HttpOnly cookie', async () => {
    authenticate.mockResolvedValue({
      sessionToken: `ms_${'a'.repeat(64)}`,
      expiresAt: '2026-07-11T03:00:00.000Z',
      context: {
        authType: 'session', personId: 'p1', collaboratorId: 'c1',
        displayName: 'Wallace', username: 'wallace.matriz', role: 'owner',
      },
    });
    const fastify = await app();
    const response = await fastify.inject({
      method: 'POST', url: '/admin/api/auth/login',
      payload: { username: 'wallace.matriz', password: 'uma-senha-forte-123' },
    });
    await fastify.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('farejador_matriz_session=ms_');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    expect(response.json()).toEqual({ user: {
      display_name: 'Wallace', username: 'wallace.matriz', role: 'owner',
      expires_at: '2026-07-11T03:00:00.000Z',
    } });
    expect(response.body).not.toContain(`ms_${'a'.repeat(64)}`);
  });

  it('reports whether first-owner bootstrap is required without exposing details', async () => {
    hasOwner.mockResolvedValue(false);
    const fastify = await app();
    const response = await fastify.inject({ method: 'GET', url: '/admin/api/auth/status' });
    await fastify.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bootstrap_required: true });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
