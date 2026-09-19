import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { list, detail } = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));
vi.mock('../../../src/admin/caixa/finance-commission-month.js', () => ({ getFinanceCommissionMonth: list, getFinanceCommissionMonthDetail: detail }));
import { registerCaixaFinanceCommissionMonthRoutes } from '../../../src/admin/caixa/route-finance-commission-month.js';
const id = '11111111-1111-4111-8111-111111111111';
async function setup(role = 'owner', authenticated = true) {
  const app = Fastify();
  registerCaixaFinanceCommissionMonthRoutes(app, async () => {}, async (request, reply) => {
    if (!authenticated) { await reply.code(401).send({ error: 'unauthorized' }); return; }
    (request as any).caixa = { panelRole: role };
  }, async () => {});
  return app;
}
describe('acesso e validação das comissões mensais', () => {
  beforeEach(() => { list.mockReset().mockResolvedValue({ period: '2026-01', summary: {} }); detail.mockReset().mockResolvedValue({ period: '2026-01' }); });
  it.each(['', '?period=2026-13', '?period=2199-01', '?period=2026-01&environment=prod'])(
    'recusa período inválido ou seleção de ambiente %s', async query => {
      const app = await setup(); const res = await app.inject('/api/caixa/financeiro-comissoes-mes' + query);
      expect(res.statusCode).toBe(400); expect(list).not.toHaveBeenCalled(); await app.close();
    });
  it.each([['admin', true, 403], ['owner', false, 401]] as const)('protege lista e detalhes %s', async (role, auth, status) => {
    const app = await setup(role, auth);
    for (const suffix of ['', '/' + id]) expect((await app.inject('/api/caixa/financeiro-comissoes-mes' + suffix + '?period=2026-01')).statusCode).toBe(status);
    expect(list).not.toHaveBeenCalled(); expect(detail).not.toHaveBeenCalled(); await app.close();
  });
  it('repassa competência, fechamento e página exatos e desativa cache', async () => {
    const app = await setup(); const res = await app.inject('/api/caixa/financeiro-comissoes-mes/' + id + '?period=2026-01&target=' + id + '&offset=50');
    expect(res.statusCode).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
    expect(detail).toHaveBeenCalledWith('2026-01', id, id, 50); await app.close();
  });
  it('falha de leitura retorna indisponível, sem números fabricados', async () => {
    list.mockRejectedValue(new Error('db_unavailable')); const app = await setup();
    const res = await app.inject('/api/caixa/financeiro-comissoes-mes?period=2026-01');
    expect(res.statusCode).toBe(503); expect(res.json()).not.toHaveProperty('summary'); await app.close();
  });
});
