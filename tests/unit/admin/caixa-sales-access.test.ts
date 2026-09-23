import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaixaAuth } from '../../../src/admin/caixa/queries.js';
import { caixaSalesScope } from '../../../src/admin/caixa/sales-access.js';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn(), detail: vi.fn() }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test', OPERACAO_LOJA_PORTAL: true } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/parceiro/db.js', () => ({ partnerPool: {} }));
vi.mock('../../../src/admin/caixa/queries.js', async (original) => ({
  ...await original<object>(), validateCaixaSession: mocks.auth,
}));
vi.mock('../../../src/admin/caixa/my-sales.js', () => ({ getCaixaMySales: mocks.list, getCaixaMySaleDetail: mocks.detail }));
import { registerCaixaRoute } from '../../../src/admin/caixa/route.js';

const headers = { authorization: 'Bearer cs_' + 'a'.repeat(64) };
const orderId = '11111111-1111-4111-8111-111111111111';
let app: ReturnType<typeof Fastify>;
let auth: CaixaAuth;
beforeEach(async () => {
  vi.clearAllMocks();
  auth = { personId: 'person', collaboratorId: 'collaborator', displayName: 'Pessoa', username: 'pessoa',
    job: 'vendedor', panelRole: null, modules: { vendas: true, estoque: false, entregas: false, retiradas: false, financeiro: false } };
  mocks.auth.mockImplementation(async () => auth);
  mocks.list.mockImplementation(async (_env, _person, _week, _db, scope) => ({ sales_scope: scope, sales: [] }));
  mocks.detail.mockImplementation(async (_env, _person, _order, _db, scope) => scope === 'matrix' ? { order_id: orderId, sales_scope: scope } : null);
  app = Fastify(); await registerCaixaRoute(app); await app.ready();
});
afterEach(async () => { await app?.close(); });

describe('abrangência das vendas por permissão', () => {
  it.each(['owner', 'admin'] as const)('%s vê bot e equipe por padrão e abre recibos sem vendedor', async (role) => {
    auth.panelRole = role;
    const list = await app.inject({ url: '/api/caixa/vendas?week=-1', headers });
    expect(list.statusCode).toBe(200); expect(list.json().sales_scope).toBe('matrix');
    expect(mocks.list).toHaveBeenCalledWith('test', 'collaborator', -1, undefined, 'matrix');
    const detail = await app.inject({ url: '/api/caixa/vendas/' + orderId + '/recibo', headers });
    expect(detail.statusCode).toBe(200); expect(detail.headers['cache-control']).toBe('no-store');
    expect(mocks.detail).toHaveBeenCalledWith('test', 'collaborator', orderId, undefined, 'matrix');
  });
  it('funcionário não amplia o acesso passando escopo, vendedor ou papel na URL', async () => {
    const list = await app.inject({ url: '/api/caixa/vendas?scope=matrix&collaboratorId=outro&role=owner', headers });
    expect(list.statusCode).toBe(200); expect(list.json().sales_scope).toBe('own');
    expect(mocks.list).toHaveBeenCalledWith('test', 'collaborator', 0, undefined, 'own');
    const detail = await app.inject({ url: '/api/caixa/vendas/' + orderId + '/recibo?scope=matrix', headers });
    expect(detail.statusCode).toBe(404);
    expect(mocks.detail).toHaveBeenCalledWith('test', 'collaborator', orderId, undefined, 'own');
  });
  it('resumo pessoal permanece próprio mesmo para o dono', async () => {
    auth.panelRole = 'owner';
    const response = await app.inject({ url: '/api/caixa/vendas?scope=own', headers });
    expect(response.json().sales_scope).toBe('own');
    expect(caixaSalesScope({ panelRole: null }, 'matrix')).toBe('own');
  });
  it('continua exigindo autenticação, módulo de vendas e período válido', async () => {
    expect((await app.inject({ url: '/api/caixa/vendas' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/caixa/vendas?week=1', headers })).statusCode).toBe(400);
    auth.modules.vendas = false; auth.panelRole = 'admin';
    expect((await app.inject({ url: '/api/caixa/vendas', headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/caixa/vendas/' + orderId + '/recibo', headers })).statusCode).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.detail).not.toHaveBeenCalled();
  });
});
