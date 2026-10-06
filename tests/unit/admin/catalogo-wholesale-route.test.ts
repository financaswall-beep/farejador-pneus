import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ save: vi.fn(), history: vi.fn() }));
vi.mock('../../../src/admin/painel/queries-catalogo-wholesale.js', () => ({
  setCatalogWholesalePrice: mocks.save, getCatalogWholesaleHistory: mocks.history,
}));
vi.mock('../../../src/admin/auth.js', () => ({
  requireAdminAuth: async (req: any, reply: any) => { if (!req.headers.authorization) reply.code(401).send({ error: 'unauthorized' }); },
  requireAdminOwner: async (req: any, reply: any) => {
    if (!req.headers.authorization) reply.code(401).send({ error: 'unauthorized' });
    else if (req.headers.authorization !== 'owner') reply.code(403).send({ error: 'admin_owner_required' });
  },
  getAdminContext: () => ({ authType: 'session', displayName: 'Maria', username: 'maria' }),
}));
let register: typeof import('../../../src/admin/painel/route-catalogo-wholesale.js').registerCatalogWholesale;
let app: FastifyInstance;
const id = '11111111-1111-4111-8111-111111111111', url = `/admin/api/catalog/${id}/wholesale-price`;
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token' });
  ({ registerCatalogWholesale: register } = await import('../../../src/admin/painel/route-catalogo-wholesale.js'));
});
beforeEach(async () => { vi.resetAllMocks(); app = Fastify(); await register(app); await app.ready(); });
afterEach(async () => app.close());
describe('rota exclusiva do atacado da Matriz', () => {
  it('exige autenticação para ler e proprietário para salvar', async () => {
    expect((await app.inject({ url: url.replace('price', 'history') })).statusCode).toBe(401);
    for (const authorization of [undefined, 'staff']) {
      const response = await app.inject({ method: 'POST', url, headers: authorization ? { authorization } : {},
        payload: { price_amount: 65, reason: 'Tabela' } });
      expect(response.statusCode).toBe(authorization ? 403 : 401);
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('aceita retirada da oferta e atribui autoria à sessão', async () => {
    mocks.save.mockResolvedValue({ changed: true, price_amount: null });
    expect((await app.inject({ method: 'POST', url, headers: { authorization: 'owner' },
      payload: { price_amount: null, reason: 'Retirar oferta' } })).statusCode).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ productId: id, priceAmount: null,
      reason: 'Retirar oferta', actorLabel: 'Maria (maria)' });
  });
  it('não aceita custo, preço de varejo, autor ou ambiente no corpo', async () => {
    for (const extra of [{ unit_cost: 40 }, { retail_price: 95 }, { actorLabel: 'outro' }, { environment: 'prod' }]) {
      expect((await app.inject({ method: 'POST', url, headers: { authorization: 'owner' },
        payload: { price_amount: 65, reason: 'Tabela', ...extra } })).statusCode).toBe(400);
    }
    for (const price_amount of [0, -1, 65.999, '65.00']) {
      expect((await app.inject({ method: 'POST', url, headers: { authorization: 'owner' },
        payload: { price_amount, reason: 'Tabela' } })).statusCode).toBe(400);
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('não devolve erro interno do banco e distingue produto ausente', async () => {
    for (const [error, status] of [['catalog_product_not_found', 404], ['segredo_db', 500]]) {
      mocks.save.mockRejectedValue(new Error(error));
      const response = await app.inject({ method: 'POST', url, headers: { authorization: 'owner' },
        payload: { price_amount: 65, reason: 'Tabela' } });
      expect(response.statusCode).toBe(status);
      if (status === 500) expect(response.body).not.toContain('segredo_db');
    }
  });
});
