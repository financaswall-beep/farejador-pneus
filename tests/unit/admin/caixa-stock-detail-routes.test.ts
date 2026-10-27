import Fastify from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ stock: vi.fn(), reservations: vi.fn(), history: vi.fn() }));
vi.mock('../../../src/admin/caixa/operation-stock-detail.js', () => ({ getMatrizOperationStockItem: mocks.stock, getMatrizStockReservations: mocks.reservations, getMatrizStockHistory: mocks.history }));
vi.mock('../../../src/admin/caixa/route-operation-catalog.js', () => ({ registerCaixaOperationCatalogRoutes: vi.fn() }));
vi.mock('../../../src/admin/caixa/operation-stock.js', () => ({ getMatrizOperationStock: vi.fn(), setMatrizOperationStockPrice: vi.fn(), MatrizOperationStockPriceError: class extends Error {} }));
let register: typeof import('../../../src/admin/caixa/route-operation-stock.js').registerCaixaOperationStockRoutes;
const stockId = '11111111-1111-4111-8111-111111111111';
beforeAll(async () => { ({ registerCaixaOperationStockRoutes: register } = await import('../../../src/admin/caixa/route-operation-stock.js')); });
afterEach(() => vi.clearAllMocks());
async function app() {
  const server = Fastify();
  register(server, async (req, reply) => { if (req.headers['x-enabled'] !== 'true') await reply.code(404).send(); },
    async (req, reply) => { if (!req.headers.authorization) await reply.code(401).send(); },
    async (req, reply) => { if (req.headers['x-stock'] !== 'true') await reply.code(403).send(); });
  await server.ready(); return server;
}
const headers = { authorization: 'fixture', 'x-enabled': 'true', 'x-stock': 'true' };
describe('acesso às novas consultas do estoque', () => {
  it('exige flag, sessão e módulo estoque nas três consultas', async () => {
    const server = await app();
    try {
      for (const suffix of ['', '/reservas', '/movimentacoes']) {
        const url = '/api/caixa/operacao/estoque/' + stockId + suffix;
        expect((await server.inject({ url })).statusCode).toBe(404);
        expect((await server.inject({ url, headers: { 'x-enabled': 'true' } })).statusCode).toBe(401);
        expect((await server.inject({ url, headers: { 'x-enabled': 'true', authorization: 'fixture' } })).statusCode).toBe(403);
      }
      expect(mocks.stock).not.toHaveBeenCalled(); expect(mocks.reservations).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it('valida parâmetros e passa página e período explicitamente', async () => {
    mocks.stock.mockResolvedValue({ stock_id: stockId }); mocks.reservations.mockResolvedValue({ reservations: {} }); mocks.history.mockResolvedValue({ history: {} });
    const server = await app();
    try {
      const base = '/api/caixa/operacao/estoque/' + stockId;
      expect((await server.inject({ url: base, headers })).headers['cache-control']).toBe('no-store');
      expect(mocks.stock).toHaveBeenCalledWith(stockId);
      expect((await server.inject({ url: base + '/reservas?page=2', headers })).statusCode).toBe(200);
      expect(mocks.reservations).toHaveBeenCalledWith(stockId, 2);
      await server.inject({ url: base + '/movimentacoes?days=all', headers });
      expect(mocks.history).toHaveBeenCalledWith(stockId, 1, null);
      for (const query of ['?page=0', '?page=10001', '?days=500', '?include_cost=true']) expect((await server.inject({ url: base + '/movimentacoes' + query, headers })).statusCode).toBe(400);
      expect((await server.inject({ url: '/api/caixa/operacao/estoque/invalid/reservas', headers })).statusCode).toBe(404);
    } finally { await server.close(); }
  });
});
