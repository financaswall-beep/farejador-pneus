import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPartnerOperationPickupRoutes } from '../../../src/parceiro/route-operation-pickups.js';

const mocks = vi.hoisted(() => ({ photo: vi.fn(), confirm: vi.fn() }));
vi.mock('../../../src/parceiro/operation-pickup-photo.js', () => ({ getPartnerPickupPhoto: mocks.photo }));
vi.mock('../../../src/parceiro/pickup-queries.js', () => ({ markPartnerPickupRetrieved: mocks.confirm,
  PickupAlreadyRetrievedError: class extends Error { code = 'pickup_already_retrieved'; } }));
vi.mock('../../../src/parceiro/auth.js', () => ({
  getPartnerContext: () => ({ environment: 'test', unitId: 'unit-a' }),
  requirePartnerAuth: async (req: any, reply: any) => { if (!req.headers.authorization) reply.code(401).send({ error: 'unauthorized' }); },
  requireScreen: (screen: string) => async (req: any, reply: any) => { if (req.headers['x-screen'] !== screen) reply.code(403).send({ error: 'forbidden' }); },
}));
const orderId = '11111111-1111-4111-8111-111111111111';
const itemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = '/parceiro/meier/api/operacao/retiradas/' + orderId;
const headers = { authorization: 'Bearer fixture', 'x-screen': 'retiradas' };
let app: ReturnType<typeof Fastify>;
beforeEach(async () => { vi.clearAllMocks(); app = Fastify(); registerPartnerOperationPickupRoutes(app); await app.ready(); });
afterEach(async () => { await app.close(); });

describe('rotas da retirada simples', () => {
  it('protege confirmação e imagem com autenticação e permissão de retiradas', async () => {
    for (const request of [{ method: 'POST' as const, url: base + '/confirmar', payload: {} }, { method: 'GET' as const, url: base + '/itens/' + itemId + '/foto' }]) {
      expect((await app.inject(request)).statusCode).toBe(401);
      expect((await app.inject({ ...request, headers: { authorization: 'Bearer fixture', 'x-screen': 'vendas' } })).statusCode).toBe(403);
    }
    expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.photo).not.toHaveBeenCalled();
  });
  it('confirma com dados do servidor e rejeita alterações financeiras no corpo', async () => {
    mocks.confirm.mockResolvedValue({ order_id: orderId, retrieved: true });
    expect((await app.inject({ method: 'POST', url: base + '/confirmar', headers, payload: {} })).statusCode).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledWith({ environment: 'test', unitId: 'unit-a' }, orderId, {});
    expect((await app.inject({ method: 'POST', url: base + '/confirmar', headers, payload: { payment_method: 'Pix', total_amount: 1 } })).statusCode).toBe(400);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
  it('retorna 404 para foto ausente e impede cache compartilhado das imagens', async () => {
    mocks.photo.mockResolvedValueOnce(null).mockResolvedValueOnce({ bytes: Buffer.from('fixture-image'), mime: 'image/webp' });
    const options = { method: 'GET' as const, url: base + '/itens/' + itemId + '/foto', headers };
    expect((await app.inject(options)).statusCode).toBe(404);
    const image = await app.inject(options);
    expect(image.statusCode).toBe(200); expect(image.headers['cache-control']).toBe('private, no-store');
    expect(image.headers['content-type']).toBe('image/webp');
    expect(mocks.photo).toHaveBeenLastCalledWith({ environment: 'test', unitId: 'unit-a' }, orderId, itemId);
  });
  it('preserva erro de reserva e não anuncia confirmação ao cliente', async () => {
    mocks.confirm.mockRejectedValueOnce(new Error('Reserva insuficiente'));
    const reply = await app.inject({ method: 'POST', url: base + '/confirmar', headers, payload: {} });
    expect(reply.statusCode).toBe(409); expect(reply.json()).toEqual({ error: 'reserva_insuficiente' });
  });
});
