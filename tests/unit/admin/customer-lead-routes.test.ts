import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { FAREJADOR_ENV:'test',MATRIZ_CUSTOMER_IDENTITY:false,ADMIN_BEARER_FALLBACK_ENABLED:false },
  avatar:vi.fn(),update:vi.fn(),session:vi.fn(),
}));
vi.mock('../../../src/shared/config/env.js',() => ({ env:mocks.env }));
vi.mock('../../../src/admin/session.js',() => ({
  ADMIN_SESSION_COOKIE:'farejador_matriz_session',validateMatrizAdminSession:mocks.session,
}));
vi.mock('../../../src/admin/painel/customer-lead-avatar.js',() => ({ getCustomerLeadAvatar:mocks.avatar }));
vi.mock('../../../src/admin/painel/customer-lead-board.js',() => ({ updateCustomerLeadBoard:mocks.update }));
vi.mock('../../../src/admin/painel/queries-clientes.js',() => ({ getClientesPainel:vi.fn() }));
vi.mock('../../../src/admin/painel/route-helpers.js',() => ({ dashboardPayload:vi.fn() }));
vi.mock('../../../src/admin/painel/route-clientes-identity.js',() => ({ registerCustomerIdentityRoutes:vi.fn() }));
vi.mock('../../../src/admin/painel/route-clientes-privacy.js',() => ({ registerCustomerPrivacyRoutes:vi.fn() }));
vi.mock('../../../src/shared/clientes-kanban.notify.js',() => ({ subscribeClientesKanban:vi.fn() }));

const id = '10000000-0000-4000-8000-000000000001';
const headers = { cookie:'farejador_matriz_session=ms_test', 'sec-fetch-site':'same-origin' };
async function withApp(run:(app:ReturnType<typeof Fastify>) => Promise<void>) {
  const app = Fastify();
  const { registerPainelClientes } = await import('../../../src/admin/painel/route-clientes.js');
  await registerPainelClientes(app);
  try { await run(app); } finally { await app.close(); }
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.env.MATRIZ_CUSTOMER_IDENTITY=false;
  mocks.session.mockResolvedValue({ role:'owner',authType:'session',displayName:'Operador teste',modules:['clientes'] });
  mocks.avatar.mockResolvedValue('https://chatwoot.example.test/avatar.png');
  mocks.update.mockResolvedValue({ manual_lane:null,archived:false,version:2 });
});

describe('rotas de Leads da Matriz com autenticação real',() => {
  it('não entrega fotos sem uma sessão autenticada',() => withApp(async app => {
    const res = await app.inject(`/admin/api/clientes/leads/${id}/avatar`);
    expect(res.statusCode).toBe(401); expect(mocks.avatar).not.toHaveBeenCalled();
  }));
  it('respeita a permissão do módulo Clientes',() => withApp(async app => {
    mocks.session.mockResolvedValue({ role:'admin',modules:['vendas'] });
    const res = await app.inject({ url:`/admin/api/clientes/leads/${id}/avatar`,headers });
    expect(res.statusCode).toBe(403); expect(mocks.avatar).not.toHaveBeenCalled();
  }));
  it('mantém a política owner-only quando a identidade protegida está ativa',() => withApp(async app => {
    mocks.env.MATRIZ_CUSTOMER_IDENTITY=true;
    mocks.session.mockResolvedValue({ role:'admin',modules:['clientes'] });
    const res = await app.inject({ url:`/admin/api/clientes/leads/${id}/avatar`,headers });
    expect(res.statusCode).toBe(403); expect(mocks.avatar).not.toHaveBeenCalled();
  }));
  it('retorna somente a URL, no ambiente correto e sem cache compartilhado',() => withApp(async app => {
    const res = await app.inject({ url:`/admin/api/clientes/leads/${id}/avatar`,headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ avatar_url:'https://chatwoot.example.test/avatar.png' });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(mocks.avatar).toHaveBeenCalledWith(id,'test');
  }));
  it('rejeita identificador inválido antes de consultar o Chatwoot',() => withApp(async app => {
    const res = await app.inject({ url:'/admin/api/clientes/leads/not-a-uuid/avatar',headers });
    expect(res.statusCode).toBe(400); expect(mocks.avatar).not.toHaveBeenCalled();
  }));
  it('não expõe detalhes internos quando a consulta da foto falha',() => withApp(async app => {
    mocks.avatar.mockRejectedValue(new Error('internal-secret-database-error'));
    const res = await app.inject({ url:`/admin/api/clientes/leads/${id}/avatar`,headers });
    expect(res.statusCode).toBe(503); expect(res.json()).toEqual({ error:'lead_avatar_unavailable' });
  }));
  it('encaminha retomada automática com controle de versão e idempotência',() => withApp(async app => {
    const res = await app.inject({ method:'PATCH',url:`/admin/api/clientes/leads/${id}`,headers,
      payload:{ action:'automatic',expected_version:1,idempotency_key:'test-resume-operation' } });
    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ action:'automatic',environment:'test',
      conversationId:id,expectedVersion:1,idempotencyKey:'test-resume-operation',actor:'Operador teste' }));
  }));
  it('rejeita escrita de outra origem, mesmo com sessão',() => withApp(async app => {
    const res = await app.inject({ method:'PATCH',url:`/admin/api/clientes/leads/${id}`,
      headers:{ cookie:headers.cookie,origin:'https://another.example.test' },
      payload:{ action:'automatic',expected_version:1,idempotency_key:'test-resume-operation' } });
    expect(res.statusCode).toBe(403); expect(mocks.update).not.toHaveBeenCalled();
  }));
});
