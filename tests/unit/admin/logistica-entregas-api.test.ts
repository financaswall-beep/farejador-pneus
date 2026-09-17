import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn() }));
const access = vi.hoisted(() => ({ allow: true }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: db }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test', MATRIZ_LOGISTICS: true } }));
vi.mock('../../../src/admin/auth.js', () => ({ requireAdminAuth: async (_: any, reply: any) => { if (!access.allow) return reply.code(401).send({ error: 'unauthorized' }); } }));
import { logisticsDeliveriesQuery } from '../../../src/admin/painel/queries-logistica-entregas.js';
import { registerLogisticsDeliveriesRoutes } from '../../../src/admin/painel/route-logistica-entregas.js';
const filter = { from: '2026-09-01', to: '2026-09-30' };
describe('API de consulta de entregas', () => {
  it('rejeita datas impossíveis, filtros inválidos e tentativa de escolher o ambiente', () => {
    for (const extra of [{ from: '2026-02-30' }, { to: '2026-08-01' }, { to: '2028-01-01' }, { environment: 'prod' }, { sort: 'drop table' }, { page: 0 }, { page_size: 10000 }]) {
      expect(logisticsDeliveriesQuery.safeParse({ ...filter, ...extra }).success).toBe(false);
    }
  });
  it('exige autenticação, valida antes de consultar e parametriza a busca no ambiente do servidor', async () => {
    db.query.mockReset().mockResolvedValue({ rows: [{ rows: [], counts: {}, total: 0, page: 1, couriers: [] }] });
    const app = Fastify(); await registerLogisticsDeliveriesRoutes(app);
    const url = '/admin/api/logistica/entregas?from=2026-09-01&to=2026-09-30';
    access.allow = false; expect((await app.inject(url)).statusCode).toBe(401); expect(db.query).not.toHaveBeenCalled();
    access.allow = true; expect((await app.inject(url + '&environment=prod')).statusCode).toBe(400); expect(db.query).not.toHaveBeenCalled();
    const response = await app.inject(url + '&q=100%25'); expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    const [sql, args] = db.query.mock.calls[0]!; expect(args[0]).toBe('test'); expect(args[3]).toBe('100\\%');
    expect(sql).toContain('o.environment=$1'); expect(sql).toContain("u.slug = 'main'"); expect(sql).toContain('oi.environment=$1'); expect(sql).not.toContain('100%');
    await app.close();
  });
});
