import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env:{ FAREJADOR_ENV:'test' as const,MATRIZ_CUSTOMER_IDENTITY:false,MATRIZ_CUSTOMER_PRIVACY:false },
  list:vi.fn(),executePrivacy:vi.fn(),
}));

vi.mock('../../../src/shared/config/env.js',() => ({ env:mocks.env }));
vi.mock('../../../src/admin/auth.js',() => ({
  requireAdminOwner:async (request: { headers:Record<string,unknown>; adminContext?:Record<string,unknown> },reply: { status:(n:number) => { send:(v:unknown) => void } }) => {
    if (request.headers['x-test-role'] !== 'owner') { reply.status(403).send({ error:'admin_owner_required' }); return; }
    request.adminContext = { personId:'owner-id',displayName:'Owner Teste',role:'owner' };
  },
  getAdminContext:(request: { adminContext?:Record<string,unknown> }) => request.adminContext,
}));
vi.mock('../../../src/admin/painel/queries-clientes-v2.js',() => ({
  getClientesPainelV2:mocks.list,getClientePainelV2ById:vi.fn(),
}));
vi.mock('../../../src/admin/painel/customer-identity-service.js',() => ({
  backfillCustomerIdentities:vi.fn(),decideIdentityCandidate:vi.fn(),listIdentityCandidates:vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/admin/painel/customer-identity-split.js',() => ({ splitCustomerIdentity:vi.fn() }));
vi.mock('../../../src/admin/painel/customer-export.js',() => ({
  auditCustomerExport:vi.fn(),streamCustomerCsv:vi.fn(),
}));
vi.mock('../../../src/admin/painel/customer-privacy-service.js',() => ({
  approvePrivacyRequest:vi.fn(),createPrivacyRequest:vi.fn(),executePrivacyRequest:mocks.executePrivacy,
  getPrivacyRequest:vi.fn(),previewPrivacyRequest:vi.fn(),verifyPrivacyRequest:vi.fn(),
}));

async function appWithRoutes() {
  const app = Fastify();
  const { registerCustomerIdentityRoutes } = await import('../../../src/admin/painel/route-clientes-identity.js');
  const { registerCustomerPrivacyRoutes } = await import('../../../src/admin/painel/route-clientes-privacy.js');
  await registerCustomerIdentityRoutes(app); await registerCustomerPrivacyRoutes(app);
  return app;
}

describe('rotas owner-only da Etapa 9',() => {
  beforeEach(() => {
    mocks.env.MATRIZ_CUSTOMER_IDENTITY=false; mocks.env.MATRIZ_CUSTOMER_PRIVACY=false;
    mocks.list.mockReset().mockResolvedValue({ rows:[],next_cursor:null });
    mocks.executePrivacy.mockReset();
  });

  it('fica dormente em 404 enquanto a flag está false',async () => {
    const app = await appWithRoutes();
    const response = await app.inject({ method:'GET',url:'/admin/api/clientes-v2',headers:{ 'x-test-role':'owner' } });
    expect(response.statusCode).toBe(404); expect(mocks.list).not.toHaveBeenCalled(); await app.close();
  });

  it('nega a V2 a qualquer papel diferente de owner',async () => {
    mocks.env.MATRIZ_CUSTOMER_IDENTITY=true;
    const app = await appWithRoutes();
    const response = await app.inject({ method:'GET',url:'/admin/api/clientes-v2',headers:{ 'x-test-role':'admin' } });
    expect(response.statusCode).toBe(403); expect(mocks.list).not.toHaveBeenCalled(); await app.close();
  });

  it('entrega nome e telefone integrais ao owner',async () => {
    mocks.env.MATRIZ_CUSTOMER_IDENTITY=true;
    mocks.list.mockResolvedValue({ rows:[{ id:'identity-1',name:'Maria Integral',phone:'+5521999991111' }],next_cursor:null });
    const app = await appWithRoutes();
    const response = await app.inject({ method:'GET',url:'/admin/api/clientes-v2',headers:{ 'x-test-role':'owner' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().rows[0]).toMatchObject({ name:'Maria Integral',phone:'+5521999991111' }); await app.close();
  });

  it('mantém a execução de anonimização bloqueada',async () => {
    mocks.env.MATRIZ_CUSTOMER_IDENTITY=true; mocks.env.MATRIZ_CUSTOMER_PRIVACY=true;
    mocks.executePrivacy.mockRejectedValue(new Error('anonymization_execution_disabled'));
    const app = await appWithRoutes();
    const response = await app.inject({ method:'POST',url:'/admin/api/privacy/requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/execute',
      headers:{ 'x-test-role':'owner' },payload:{ confirmation:'EXECUTAR ANONIMIZACAO' } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error:'anonymization_execution_disabled',destructive_changes:false }); await app.close();
  });
});
