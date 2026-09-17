import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn() }));
const access = vi.hoisted(() => ({ allow: true }));
const config = vi.hoisted(() => ({ FAREJADOR_ENV: 'test', MATRIZ_LOGISTICS: true }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: db }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: config }));
vi.mock('../../../src/admin/auth.js', () => ({ requireAdminAuth: async (_: any, reply: any) => { if (!access.allow) return reply.code(401).send({ error: 'unauthorized' }); } }));
import { logisticsHistoryQuery } from '../../../src/admin/painel/queries-logistica-historico.js';
import { registerLogisticsHistoryRoutes } from '../../../src/admin/painel/route-logistica-historico.js';
const filter = { from: '2024-01-01', to: '2024-01-31' };
describe('API de histórico de rotas', () => {
  it('aceita datas antigas e rejeita datas impossíveis, período excessivo e ambiente do cliente', () => {
    expect(logisticsHistoryQuery.safeParse(filter).success).toBe(true);
    for (const extra of [{ from:'2024-02-30' }, { to:'2023-12-01' }, { to:'2025-01-01' }, { environment:'prod' }, { financial:'anything' }, { page:0 }, { page:100001 }]) {
      expect(logisticsHistoryQuery.safeParse({...filter,...extra}).success).toBe(false);
    }
  });
  it('protege as duas consultas, verifica a flag e parametriza a busca literal no ambiente do servidor', async () => {
    db.query.mockReset().mockResolvedValue({rows:[{rows:[],page:1,summary:{closed:0},couriers:[]}]});
    const app=Fastify(); await registerLogisticsHistoryRoutes(app);
    const url='/admin/api/logistica/historico?from=2024-01-01&to=2024-01-31';
    const detail='/admin/api/logistica/historico/11111111-1111-4111-8111-111111111111/entregas';
    access.allow=false;
    for (const path of [url,detail]) expect((await app.inject(path)).statusCode).toBe(401);
    expect(db.query).not.toHaveBeenCalled(); access.allow=true; config.MATRIZ_LOGISTICS=false;
    for (const path of [url,detail]) expect((await app.inject(path)).statusCode).toBe(404);
    config.MATRIZ_LOGISTICS=true;
    expect((await app.inject(url+'&environment=prod')).statusCode).toBe(400);
    expect((await app.inject('/admin/api/logistica/historico/invalid/entregas')).statusCode).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
    const res=await app.inject(url+'&q=100%25_'); expect(res.statusCode).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
    const [sql,args]=db.query.mock.calls[0]!; expect(args[0]).toBe('test'); expect(args[3]).toBe('100\\%\\_'); expect(sql).not.toContain('100%');
    await app.inject(detail); expect(db.query.mock.calls[1]![1]).toEqual(['test','11111111-1111-4111-8111-111111111111']);
    await app.close();
  });
});
