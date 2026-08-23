import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authenticate = vi.fn();
const mintAdmin = vi.fn();
const mintPartner = vi.fn();
const hasOwner = vi.fn();
const listWorkplaces = vi.fn();

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
      mintMatrizAdminSessionForPerson: mintAdmin,
      bootstrapMatrizOwner: vi.fn(),
      hasMatrizOwner: hasOwner,
      revokeMatrizAdminSession: vi.fn(),
      validateMatrizAdminSession: vi.fn(),
    };
  });
  vi.doMock('../../../src/admin/caixa/operation-auth.js', () => ({
    authenticatePanelAccess: authenticate,
    listOperationWorkplaces: listWorkplaces,
    publicOperationWorkplace: (workplace: Record<string, unknown>) => ({
      id: workplace.id, kind: workplace.kind, name: workplace.name, role: workplace.role,
    }),
  }));
  vi.doMock('../../../src/parceiro/queries.js', () => ({
    mintPartnerSession: mintPartner,
  }));
  vi.doMock('../../../src/admin/auth.js', () => ({
    extractAdminSessionCookie: vi.fn(),
    hasValidEmergencyAdminToken: vi.fn(() => false),
    requireAdminAuth: async (request: Record<string, unknown>) => {
      request.adminContext = {
        authType: 'session', personId: 'p1', collaboratorId: 'c1',
        displayName: 'Wallace', username: 'wallace.matriz', role: 'owner',
      };
    },
    getAdminContext: (request: { adminContext: unknown }) => request.adminContext,
  }));
  const fastify = Fastify();
  const { registerAdminLoginRoute } = await import('../../../src/admin/login.route.js');
  await registerAdminLoginRoute(fastify);
  return fastify;
}

afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe('admin login route', () => {
  it('sets the opaque session only in an HttpOnly cookie', async () => {
    authenticate.mockResolvedValue({
      personId: 'p1', username: 'wallace.matriz', workplaces: [{
        id: 'matrix', kind: 'matrix', name: 'Matriz', role: 'owner',
        collaboratorId: 'c1', modules: { vendas: true, estoque: true, entregas: true, financeiro: true },
      }],
    });
    mintAdmin.mockResolvedValue({
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
    expect(response.json()).toMatchObject({
      mode: 'direct', scope: 'matrix',
      workplace: { id: 'matrix', kind: 'matrix', role: 'owner' },
      user: { display_name: 'Wallace', username: 'wallace.matriz', role: 'owner' },
    });
    expect(response.body).not.toContain(`ms_${'a'.repeat(64)}`);
  });

  it('issues ps_ for a partner without creating a matrix cookie', async () => {
    authenticate.mockResolvedValue({
      personId: 'p2', username: 'parceiro', workplaces: [{
        id: 'partner:rio-do-ouro', kind: 'partner', name: 'Rio do Ouro', role: 'owner',
        slug: 'rio-do-ouro', tokenId: 'token-2', displayName: 'Dono',
        modernPanelEnabled: true,
        modules: { vendas: true, estoque: true, entregas: true, financeiro: true },
      }],
    });
    mintPartner.mockResolvedValue({
      session_token: `ps_${'b'.repeat(64)}`, expires_at: '2026-08-30T03:00:00.000Z',
    });
    const fastify = await app();
    const response = await fastify.inject({
      method: 'POST', url: '/admin/api/auth/login',
      payload: { username: 'parceiro', password: 'uma-senha-forte-123' },
    });
    await fastify.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: 'direct', scope: 'partner', slug: 'rio-do-ouro',
      session_token: `ps_${'b'.repeat(64)}`,
      modern_panel_enabled: true,
    });
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    expect(mintAdmin).not.toHaveBeenCalled();
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

  it('returns the authenticated workplace and server-derived panel modules', async () => {
    listWorkplaces.mockResolvedValue([{
      id: 'matrix', kind: 'matrix', name: 'Matriz', role: 'owner', collaboratorId: 'c1',
      modules: { vendas: true, estoque: true, entregas: true, financeiro: true },
    }]);
    const fastify = await app();
    const response = await fastify.inject({ method: 'GET', url: '/admin/api/auth/me' });
    await fastify.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { role: 'owner', auth_type: 'session' },
      workplace: { id: 'matrix', kind: 'matrix', role: 'owner' },
      modules: expect.arrayContaining(['resumo', 'financeiro', 'marketing', 'colaboradores']),
    });
  });
});
