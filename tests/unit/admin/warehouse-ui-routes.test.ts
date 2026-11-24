import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ groups: vi.fn(), saveGroup: vi.fn(), move: vi.fn(), allocations: vi.fn(),
  reference: vi.fn(), saveReference: vi.fn(), origins:vi.fn(), confirmOrigin:vi.fn() }));
vi.mock('../../../src/admin/painel/stock-origin.js', () => ({
  listStockOriginPendings:mocks.origins, confirmStockOrigin:mocks.confirmOrigin,
}));

vi.mock('../../../src/admin/auth.js', () => ({
  requireAdminAuth: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization) reply.code(401).send({ error: 'unauthorized' });
  },
  requireAdminOwner: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization) reply.code(401).send({ error: 'unauthorized' });
    else if (request.headers.authorization !== 'owner') reply.code(403).send({ error: 'owner_required' });
  },
  getAdminContext: () => ({ authType: 'session', displayName: 'Maria', username: 'maria' }),
}));
vi.mock('../../../src/admin/painel/stock-groups.js', () => ({
  listMatrizStockGroups: mocks.groups, moveMatrizStockGroup: mocks.move, saveMatrizStockGroup: mocks.saveGroup,
  listMatrizOrderGroupPositionsForOrders: mocks.allocations,
}));
vi.mock('../../../src/shared/catalog-market-reference.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/shared/catalog-market-reference.js')>(),
  getMarketReference: mocks.reference, setMarketReference: mocks.saveReference,
}));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: async () => ({ rows: [] }) } }));

const stock = '11111111-1111-4111-8111-111111111111';
const product = '22222222-2222-4222-8222-222222222222';
const group = '33333333-3333-4333-8333-333333333333';
const groupPath = '/admin/api/wholesale/stock/groups';
const marketPath = `/admin/api/catalog/${product}/market-reference`;
const owner = { authorization: 'owner' }, staff = { authorization: 'staff' };
const newGroup = { stock_id: stock, product_id: product, inspection_status: 'located',
  positions: [{ location_code: 'A1', quantity: 2 }], reason: 'Conferência', idempotency_key: 'operation-101' };
const reference = { model: 'Dueler', amount: 875, sources: ['https://example.com/dueler'],
  observed_on: '2026-11-21', valid_until: '2026-12-01', bot_enabled: false };

let app: FastifyInstance;
let registerStock: typeof import('../../../src/admin/painel/route-stock-groups.js').registerStockGroupRoutes;
let registerMarket: typeof import('../../../src/admin/painel/route-market-reference.js').registerMarketReferenceRoutes;

beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token' });
  ({ registerStockGroupRoutes: registerStock } = await import('../../../src/admin/painel/route-stock-groups.js'));
  ({ registerMarketReferenceRoutes: registerMarket } = await import('../../../src/admin/painel/route-market-reference.js'));
});
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.origins.mockResolvedValue([]);
  app = Fastify();
  registerStock(app);
  registerMarket(app);
  await app.ready();
});
afterEach(async () => app.close());

describe('rotas de pilhas e referências da Matriz', () => {
  it('confirma origem no Estoque com permissão, chave de repetição e quantidades positivas por candidato', async () => {
    const url = '/admin/api/wholesale/stock/origins';
    const payload = { selections:[{candidate_id:product,quantity:1}], idempotency_key:stock };
    expect((await app.inject({url})).statusCode).toBe(401);
    expect((await app.inject({url:url+'?order_id='+group,headers:staff})).statusCode).toBe(200);
    expect(mocks.origins).toHaveBeenCalledWith(expect.anything(),'test',expect.objectContaining({orderIds:[group]}));
    const post=(headers:Record<string,string>,body=payload)=>app.inject({method:'POST',url:url+'/'+group,headers,payload:body});
    expect((await post(staff)).statusCode).toBe(403);
    expect((await post(owner,{...payload,selections:[...payload.selections,...payload.selections]})).statusCode).toBe(400);
    expect(mocks.confirmOrigin).not.toHaveBeenCalled();
    mocks.confirmOrigin.mockResolvedValue({id:group,status:'confirmed'});
    expect((await post(owner)).json()).toEqual({id:group,status:'confirmed'});
    mocks.confirmOrigin.mockRejectedValueOnce(Error('stock_origin_changed'));
    expect((await post(owner)).statusCode).toBe(409);
  });
  it('exige operador de estoque para ler grupos e proprietário para editar ou consultar referências', async () => {
    expect((await app.inject({ url: groupPath })).statusCode).toBe(401);
    expect((await app.inject({ url: marketPath, headers: staff })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: groupPath, headers: staff, payload: newGroup })).statusCode).toBe(403);
    expect(mocks.saveGroup).not.toHaveBeenCalled();
    mocks.groups.mockResolvedValue([]);
    const result = await app.inject({ url: `${groupPath}?stock_id=${stock}`, headers: staff });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(mocks.groups).toHaveBeenCalledWith(expect.anything(), 'test', stock);
  });

  it('salva localização sem modelo e exige que o conjunto seja inspecionado e identificado', async () => {
    mocks.saveGroup.mockResolvedValue({ group_id: group });
    const save = (payload: typeof newGroup & Record<string, unknown>) => app.inject({
      method: 'POST', url: groupPath, headers: owner, payload,
    });
    expect((await save({ ...newGroup, model: null })).statusCode).toBe(200);
    expect(mocks.saveGroup).toHaveBeenCalledWith(expect.anything(), 'test', { ...newGroup, model: null }, 'Maria (maria)');
    for (const falseGroup of [{ matched_set: true }, { conservation_grade: 'economico' }, { environment: 'prod' }]) {
      expect((await save({ ...newGroup, ...falseGroup })).statusCode).toBe(400);
    }
    expect(mocks.saveGroup).toHaveBeenCalledTimes(1);
  });

  it('rejeita pilha igual mesmo com letra diferente e informa conflito de revisão', async () => {
    const attempt = (to_location: string) => app.inject({ method: 'POST', url: `${groupPath}/${group}/move`,
      headers: owner, payload: { revision: '1', from_location: 'A1', to_location, quantity: 1,
        reason: 'Reorganizar', idempotency_key: 'operation-102' } });
    expect((await attempt('a1')).statusCode).toBe(400);
    expect(mocks.move).not.toHaveBeenCalled();
    mocks.move.mockRejectedValue(new Error('stock_group_offer_changed'));
    expect((await attempt('B1')).json()).toEqual({ error: 'stock_group_offer_changed' });
    expect(mocks.move).toHaveBeenCalledWith(expect.anything(), 'test', expect.objectContaining({ group_id: group }), 'Maria (maria)');
  });

  it('salva referência isolada do preço de venda e valida escopo, fontes e autorização', async () => {
    mocks.saveReference.mockResolvedValue(reference);
    const write = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: marketPath, headers: owner, payload });
    expect((await write(reference)).json()).toEqual({ reference });
    expect(mocks.saveReference).toHaveBeenCalledWith({ ...reference, product_id: product }, 'Maria (maria)');
    for (const invalid of [{ unit_cost: 500 }, { price_amount: 900 }, { product_id: stock }, { environment: 'prod' },
      { sources: ['javascript:alert(1)'] }, { bot_enabled: true, valid_until: null }]) {
      expect((await write({ ...reference, ...invalid })).statusCode).toBe(400);
    }
    expect(mocks.saveReference).toHaveBeenCalledTimes(1);
    mocks.saveReference.mockRejectedValue(new Error('market_reference_model_mismatch'));
    expect((await write({ ...reference, bot_enabled: true })).statusCode).toBe(409);
  });
});

describe('posições exibidas para separação', () => {
  it('apresenta a sugestão pendente sem exibir a baixa provisória como origem confirmada', async () => {
    const { addStockPickingPositions } = await import('../../../src/admin/painel/stock-group-picking.js');
    const { pool } = await import('../../../src/persistence/db.js');
    const issue = {id:group,order_id:'o',product_id:'p',quantity:1,candidates:[{candidate_id:stock,location_code:'C2',suggested_quantity:1}]};
    mocks.origins.mockResolvedValue([issue]);
    mocks.allocations.mockResolvedValue([{order_id:'o',order_item_id:'i',product_id:'p',status:'consumed',location_code:'C2',quantity:1},
      {order_id:'o',order_item_id:'j',product_id:'q',status:'reserved',location_code:'F2',quantity:1,model:null}]);
    const o={order_id:'o',items:[{order_item_id:'i'},{order_item_id:'j'}]};
    await addStockPickingPositions(pool,'test',[o],'pending_delivery');
    expect(o).toEqual({order_id:'o',stock_origin_pendings:[issue],items:[{order_item_id:'i'},
      {order_item_id:'j',stock_positions:[{location_code:'F2',quantity:1,model:null}]}]});
  });
  it.each(['pending_delivery','open_pickup'] as const)('associa somente posições utilizáveis da fila %s ao item do mesmo pedido', async stage => {
    const { addStockPickingPositions } = await import('../../../src/admin/painel/stock-group-picking.js');
    const { pool } = await import('../../../src/persistence/db.js');
    mocks.allocations.mockResolvedValue([
      { order_id: 'first', order_item_id: 'item', status: 'reserved', location_code: 'B2', quantity: 2, model: 'Scorpion' },
      { order_id: 'first', order_item_id: 'item', status: 'consumed', location_code: 'B1', quantity: 1, model: null },
      { order_id: 'first', order_item_id: 'item', status: 'released', location_code: 'B3', quantity: 1, model: null },
      { order_id: 'first', order_item_id: null, status: 'consumed', location_code: 'D4', quantity: 1, model: null },
      { order_id: 'other', order_item_id: 'item', status: 'reserved', location_code: 'A1', quantity: 1, model: null },
    ]);
    const orders = [{ order_id: 'first', items: [{ order_item_id: 'item' }, { order_item_id: 'other-item' }] }];
    await addStockPickingPositions(pool, 'test', orders, stage);
    expect(mocks.allocations).toHaveBeenCalledWith(pool, 'test', ['first'], true);
    const expectedPositions = [{ location_code: 'B2', quantity: 2, model: 'Scorpion' },
      ...(stage === 'pending_delivery' ? [{ location_code: 'B1', quantity: 1, model: null }] : [])];
    expect(orders[0]!.items).toEqual([{ order_item_id: 'item', stock_positions: expectedPositions }, { order_item_id: 'other-item' }]);
  });
  it('consolida as linhas repetidas por SKU sem duplicar quantidades ou exibir posições liberadas e órfãs', async () => {
    const { addStockPickingPositions } = await import('../../../src/admin/painel/stock-group-picking.js');
    const { pool } = await import('../../../src/persistence/db.js');
    const shared = { order_id: 'o', product_id: 'p', product_name: 'Modelo A', order_item_id: null,
      matching_items: 2, status: 'reserved', location_code: 'B2', quantity: 1, model: null };
    mocks.allocations.mockResolvedValue([shared, { ...shared, quantity: 2 },
      { ...shared, location_code: 'B5', status: 'released' }, { ...shared, matching_items: 0, location_code: 'C2' },
      { ...shared, order_id: 'outro' }]);
    const order = { order_id: 'o', items: [{ order_item_id: 'um' }, { order_item_id: 'dois' }] };
    await addStockPickingPositions(pool, 'test', [order], 'open_pickup');
    await addStockPickingPositions(pool, 'test', [order], 'open_pickup');
    expect(order).toEqual({ order_id: 'o', items: [{ order_item_id: 'um' }, { order_item_id: 'dois' }],
      shared_stock_positions: [{ product_id: 'p', product_name: 'Modelo A', positions: [{ location_code: 'B2', quantity: 3, model: null }] }] });
  });
});
