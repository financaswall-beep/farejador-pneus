import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const image = vi.hoisted(() => vi.fn());
vi.mock('../../../src/shared/config/env.js', () => ({ env: { MATRIZ_LOGISTICS: true, FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test', DATABASE_SSL: false } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../../src/admin/entregador/queries.js', () => ({
  getEntregadorReceiptImage: image, getEntregadorProductPhotoImage: vi.fn(), addEntregadorReceipt: vi.fn(),
  closeEntregadorTrip: vi.fn(), openEntregadorTrip: vi.fn(), reportEntregadorFail: vi.fn(), setEntregadorDeliveryStatus: vi.fn(),
}));
vi.mock('../../../src/admin/caixa/deliveries.js', () => ({ getCaixaDeliveries: vi.fn(), caixaCourierAuth: (auth: unknown) => auth }));
vi.mock('../../../src/admin/painel/receipt-ai-flow.js', () => ({ extractReceiptSuggestion: vi.fn() }));
import { registerCaixaDeliveryRoutes } from '../../../src/admin/caixa/route-deliveries.js';
import { registerCaixaStaticRoutes } from '../../../src/admin/caixa/route-static.js';

const id = '00000000-0000-4000-8000-000000000001';
async function app(allowed = true) {
  const server = Fastify();
  registerCaixaDeliveryRoutes(server, async () => {}, async (request: any, reply) => {
    if (!request.headers.authorization) return void reply.code(401).send({ error: 'unauthorized' });
    request.caixa = { personId: 'person-a', collaboratorId: 'courier-a', displayName: 'Entregador A' };
  }, async (_request, reply) => { if (!allowed) return void reply.code(403).send({ error: 'forbidden' }); });
  return server;
}
describe('foto da nota fiscal no app da Matriz', () => {
  beforeEach(() => { vi.clearAllMocks(); image.mockResolvedValue({ bytes: Buffer.from('fixture'), mime: 'image/jpeg' }); });
  it('serve a foto com autenticação, posse e cache privado', async () => {
    const server = await app();
    try {
      const result = await server.inject({ url: '/api/caixa/entregas/rota/comprovantes/' + id, headers: { authorization: 'fixture' } });
      expect(result.statusCode).toBe(200); expect(result.body).toBe('fixture');
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.headers['content-type']).toContain('image/jpeg');
      expect(image).toHaveBeenCalledWith(expect.objectContaining({ collaboratorId: 'courier-a' }), id);
    } finally { await server.close(); }
  });
  it('recusa leitura sem sessão e sem permissão de entrega', async () => {
    for (const allowed of [true, false]) {
      const server = await app(allowed);
      try {
        expect((await server.inject({ url: '/api/caixa/entregas/rota/comprovantes/' + id,
          headers: allowed ? {} : { authorization: 'fixture' } })).statusCode).toBe(allowed ? 401 : 403);
      } finally { await server.close(); }
    }
    expect(image).not.toHaveBeenCalled();
  });
  it('não expõe foto inexistente/de outro entregador nem aceita identificador inválido', async () => {
    const server = await app(); image.mockResolvedValue(null);
    try {
      for (const key of [id, 'invalido']) expect((await server.inject({ url: '/api/caixa/entregas/rota/comprovantes/' + key,
        headers: { authorization: 'fixture' } })).statusCode).toBe(404);
      expect(image).toHaveBeenCalledTimes(1);
    } finally { await server.close(); }
  });
  it('entrega os módulos declarados pelo HTML com cache-bust e respeita a flag', async () => {
    const server = Fastify(); let enabled = true;
    registerCaixaStaticRoutes(server, async (_request, reply) => { if (!enabled) return void reply.code(404).send(); });
    try {
      const html = await server.inject('/operacao');
      const scripts = [...html.body.matchAll(/src="(\/operacao\/caixa-deliveries-flow-[^"?]+\.js\?v=[^"]+)"/g)].map(row => row[1]!);
      expect(scripts).toHaveLength(3);
      for (const url of scripts) {
        const result = await server.inject(url); expect(result.statusCode).toBe(200);
        expect(result.headers['content-type']).toContain('text/javascript');
        expect(result.body).toContain('window.Caixa');
      }
      enabled = false; expect((await server.inject(scripts[0]!)).statusCode).toBe(404);
    } finally { await server.close(); }
  });
});
