import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaixaAuth } from '../../../src/admin/caixa/queries.js';
const calls = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), eligible: vi.fn(), byPurchase: vi.fn(), create: vi.fn(), change: vi.fn(), link: vi.fn(), receipts: vi.fn() }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/admin/painel/queries-purchase-groups.js', () => ({ listPurchaseGroups: calls.list, getPurchaseGroup: calls.get,
  eligiblePurchaseGroupExpenses: calls.eligible, purchaseGroupForPurchase: calls.byPurchase }));
vi.mock('../../../src/admin/painel/queries-purchase-groups-write.js', () => ({ createPurchaseGroup: calls.create, changePurchaseGroup: calls.change, linkPurchaseGroup: calls.link }));
vi.mock('../../../src/admin/painel/purchase-group-receipts.js', () => ({ purchaseGroupReceipts: calls.receipts }));

describe('Viagens do app: mesmas regras do web e sessão da Matriz', () => {
  let app: ReturnType<typeof Fastify>;
  const base = '/api/caixa/operacao/compras/viagens', id = '11111111-1111-4111-8111-111111111111';
  beforeEach(async () => {
    vi.resetAllMocks(); app = Fastify();
    const { registerCaixaPurchaseGroupRoutes } = await import('../../../src/admin/caixa/route-purchase-groups.js');
    const auth = async (request: FastifyRequest, reply: any) => {
      if (!request.headers.authorization) { await reply.code(401).send({ error: 'unauthorized' }); return; }
      (request as FastifyRequest & { caixa: Partial<CaixaAuth> }).caixa = { panelRole: request.headers.authorization === 'owner' ? 'owner' : 'admin', displayName: 'Dono', username: 'dono' };
    };
    registerCaixaPurchaseGroupRoutes(app, { preHandler: [auth, async (request, reply) => {
      if ((request as FastifyRequest & { caixa: CaixaAuth }).caixa.panelRole !== 'owner') await reply.code(403).send({ error: 'forbidden' });
    }] });
    await app.ready(); calls.list.mockResolvedValue({ rows: [], has_more: false }); calls.receipts.mockResolvedValue([]);
  });
  afterEach(() => app.close());
  it('toda leitura e escrita exige os mesmos guardas de proprietário das compras', async () => {
    for (const suffix of ['', '/elegiveis', '/da-compra/' + id, '/' + id]) {
      expect((await app.inject(base + suffix)).statusCode).toBe(401);
      expect((await app.inject({ url: base + suffix, headers: { authorization: 'admin' } })).statusCode).toBe(403);
    }
    for (const suffix of ['', '/' + id + '/acao', '/' + id + '/vinculo']) {
      expect((await app.inject({ method: 'POST', url: base + suffix, headers: { authorization: 'admin' }, payload: {} })).statusCode).toBe(403);
    }
    expect(calls.list).not.toHaveBeenCalled(); expect(calls.create).not.toHaveBeenCalled();
  });
  it('mantém ambiente e autor do servidor, chave idempotente e o serviço central', async () => {
    calls.create.mockResolvedValue({ id });
    const result = await app.inject({ method: 'POST', url: base, headers: { authorization: 'owner' },
      payload: { name: 'São Paulo', idempotency_key: 'trip-app-create', environment: 'prod', actor: 'forjado', amount: 1 } });
    expect(result.statusCode).toBe(201);
    expect(calls.create).toHaveBeenCalledWith({ name: 'São Paulo', idempotency_key: 'trip-app-create', environment: 'test', actor: 'Caixa: Dono (dono)' });
  });
  it('devolve os valores centrais e só acrescenta a referência ao comprovante', async () => {
    const data = { group: { id }, summary: { total: '1200.00', cost_per_tire: '12.00' }, purchases: [], expenses: [{ id, amount: '100.00' }] };
    calls.get.mockResolvedValue(data); calls.receipts.mockResolvedValue([{ expense_id: id, receipt_id: 'foto' }]);
    const result = await app.inject({ url: base + '/' + id, headers: { authorization: 'owner' } });
    expect(result.json()).toMatchObject({ summary: data.summary, expenses: [{ id, amount: '100.00', receipt_id: 'foto' }] });
    expect(calls.get).toHaveBeenCalledWith(id, 'test');
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('vincular/desvincular chama apenas o serviço de etiquetas', async () => {
    calls.link.mockResolvedValue({ linked: true });
    const payload = { kind: 'expense', record_id: id, unlink: true, idempotency_key: 'trip-app-unlink' };
    expect((await app.inject({ method: 'POST', url: base + '/' + id + '/vinculo', headers: { authorization: 'owner' }, payload })).statusCode).toBe(200);
    expect(calls.link).toHaveBeenCalledWith({ ...payload, group_id: id, environment: 'test', actor: 'Caixa: Dono (dono)' });
    expect(calls.create).not.toHaveBeenCalled(); expect(calls.change).not.toHaveBeenCalled();
  });
  it('propaga viagem fechada como conflito e valida IDs e paginação', async () => {
    calls.link.mockRejectedValue(new Error('purchase_group_closed'));
    const result = await app.inject({ method: 'POST', url: base + '/' + id + '/vinculo', headers: { authorization: 'owner' },
      payload: { kind: 'expense', record_id: id, idempotency_key: 'trip-app-link-closed' } });
    expect(result.statusCode).toBe(409); expect(result.json().error).toBe('purchase_group_closed');
    expect((await app.inject({ url: base + '/invalid', headers: { authorization: 'owner' } })).statusCode).toBe(400);
    expect((await app.inject({ url: base + '?page=-1', headers: { authorization: 'owner' } })).statusCode).toBe(400);
  });
});
