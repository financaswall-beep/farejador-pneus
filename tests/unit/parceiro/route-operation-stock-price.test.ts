import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token' });
  return { save: vi.fn(), identity: vi.fn(), role: 'owner' };
});
vi.mock('../../../src/parceiro/db.js', () => ({ partnerPool: { query: vi.fn() } }));
vi.mock('../../../src/parceiro/auth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/parceiro/auth.js')>();
  return { ...actual, requirePartnerAuth: async (request: any) => {
    request.partnerContext = { environment: 'test', partnerUnitId: 'partner-unit-a', unitId: 'unit-a',
      role: mocks.role, tokenId: 'token-a' };
  }, requireScreen: () => async () => {} };
});
vi.mock('../../../src/parceiro/queries.js', () => ({ getPartnerSelfIdentity: mocks.identity }));
vi.mock('../../../src/parceiro/operation-stock-price.js', () => ({
  setPartnerOperationStockPrice: mocks.save, OperationStockPriceError: class extends Error {},
}));
import { registerPartnerOperationStockPriceRoutes } from '../../../src/parceiro/route-operation-stock-price.js';

const url = '/parceiro/loja/api/operacao/estoque/11111111-1111-4111-8111-111111111111/preco';
const payload = { sale_price: 99.9, reason: 'Ajuste da revenda' };
beforeEach(() => {
  mocks.role = 'owner'; mocks.save.mockReset().mockResolvedValue({ changed: true, sale_price: 99.9 });
  mocks.identity.mockReset().mockResolvedValue({ display_name: 'Dono' });
});
describe('permissão do preço de venda do parceiro na API', () => {
  it('aceita o dono e usa a unidade da sessão, sem aceitar custo ou saldo no corpo', async () => {
    const app = Fastify(); registerPartnerOperationStockPriceRoutes(app);
    try {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(200);
      expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ unitId: 'unit-a', role: 'owner' }),
        'Dono', '11111111-1111-4111-8111-111111111111', 99.9, 'Ajuste da revenda');
      mocks.save.mockClear();
      for (const extra of [{ unit_id: 'unit-b' }, { average_cost: 55 }, { quantity_on_hand: 20 }]) {
        expect((await app.inject({ method: 'POST', url, payload: { ...payload, ...extra } })).statusCode).toBe(400);
      }
      expect(mocks.save).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('recusa funcionário mesmo que tenha permissão de estoque, antes de acessar o item', async () => {
    mocks.role = 'funcionario';
    const app = Fastify(); registerPartnerOperationStockPriceRoutes(app);
    try {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'partner_forbidden_owner_only' });
      expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
