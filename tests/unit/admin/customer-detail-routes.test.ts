import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ env:{ FAREJADOR_ENV:'test',MATRIZ_CUSTOMER_IDENTITY:false,
  ADMIN_BEARER_FALLBACK_ENABLED:false },session:vi.fn(),detail:vi.fn() }));
vi.mock('../../../src/shared/config/env.js',() => ({ env:mocks.env }));
vi.mock('../../../src/admin/session.js',() => ({
  ADMIN_SESSION_COOKIE:'farejador_matriz_session',validateMatrizAdminSession:mocks.session,
}));
vi.mock('../../../src/admin/painel/customer-detail.js',() => ({ getCustomerDetail:mocks.detail }));
const id = '10000000-0000-4000-8000-000000000001';
const headers = { cookie:'farejador_matriz_session=ms_test' };
async function request(url:string, authenticated=true) {
  const app = Fastify();
  const { registerCustomerDetailRoute } = await import('../../../src/admin/painel/route-customer-detail.js');
  await registerCustomerDetailRoute(app);
  try { return await app.inject({ url,headers:authenticated ? headers : {} }); }
  finally { await app.close(); }
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.env.MATRIZ_CUSTOMER_IDENTITY=false;
  mocks.session.mockResolvedValue({ role:'owner',modules:['clientes'] });
  mocks.detail.mockResolvedValue({ customer:{ name:'Ana' },orders:[] });
});
describe('ficha de cliente — leitura protegida',() => {
  it('exige sessão e permissão de Clientes',async () => {
    expect((await request(`/admin/api/clientes/parceiro/${id}/ficha`,false)).statusCode).toBe(401);
    mocks.session.mockResolvedValue({ role:'admin',modules:['vendas'] });
    expect((await request(`/admin/api/clientes/parceiro/${id}/ficha`)).statusCode).toBe(403);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it('preserva owner-only quando identidade está ativa',async () => {
    mocks.env.MATRIZ_CUSTOMER_IDENTITY=true;
    mocks.session.mockResolvedValue({ role:'admin',modules:['clientes'] });
    expect((await request(`/admin/api/clientes/chatwoot/${id}/ficha`)).statusCode).toBe(403);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it.each(['chatwoot','balcao','parceiro','atacado'])('consulta %s por ID, ambiente e paginação',async source => {
    const res = await request(`/admin/api/clientes/${source}/${id}/ficha?offset=10&limit=10`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(mocks.detail).toHaveBeenCalledWith('test',source,id,{ offset:10,limit:10 });
  });
  it.each([`invalid/${id}/ficha`,`chatwoot/not-uuid/ficha`,`chatwoot/${id}/ficha?offset=-1`,
    `balcao/${id}/ficha?limit=31`,`parceiro/${id}/ficha?offset=1.5`])('rejeita parâmetro inválido %s',async path => {
    expect((await request('/admin/api/clientes/'+path)).statusCode).toBe(400);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it('retorna 404 para cadastro ausente e erro opaco para indisponibilidade',async () => {
    mocks.detail.mockResolvedValueOnce(null);
    expect((await request(`/admin/api/clientes/balcao/${id}/ficha`)).statusCode).toBe(404);
    mocks.detail.mockRejectedValueOnce(new Error('sql-secret'));
    const res = await request(`/admin/api/clientes/balcao/${id}/ficha`);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error:'customer_detail_unavailable' });
  });
});
